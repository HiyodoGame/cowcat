import type { AuditRecord, AuditSink } from '../ports/audit.js';
import type { ExecutionFacts } from '../ports/process.js';
import type { ApprovalBy, ApprovalVerdict } from './approval.js';
import type { Verdict } from './decide.js';

// The audit consumer (ADR-033).
//
// It is a CONSUMER of the event stream, not a branch inside the turn loop: it is fed
// whatever `Session.subscribe` hands out and has no way to influence a turn. That is
// what makes "an audit can never break a session" structurally true rather than a
// promise.
//
// The event types are imported as TYPES only, so this file still has no runtime
// dependency on the kernel — it is a pure projection from events to rows.

/** The parts of a `KernelEvent` this consumer needs, named structurally. */
interface EventLike {
  readonly type: string;
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly callId?: string;
  readonly name?: string;
  readonly decision?: { readonly verdict: Verdict; readonly rule: string };
  readonly verdict?: ApprovalVerdict;
  readonly by?: ApprovalBy;
  readonly ok?: boolean;
  readonly facts?: ExecutionFacts | null;
}

export interface AuditSummary {
  readonly written: number;
  readonly failed: number;
  readonly inFlight: number;
  /** The most recent failure, so a session-end report can say something useful. */
  readonly lastFailure: string | null;
}

interface Pending {
  verdict: Verdict;
  rule: string;
  approval: { verdict: ApprovalVerdict; by: ApprovalBy } | null;
}

/**
 * Joins the events of one tool call into one audit row, and writes it when the call
 * finishes.
 *
 * Ordering is what makes the join possible: `policy.decided` and
 * `approval.answered` both precede the `tool.finished` they belong to, and all three
 * carry the same `callId`.
 */
export class AuditConsumer {
  readonly #sink: AuditSink;
  readonly #pending = new Map<string, Pending>();
  readonly #inFlight = new Set<Promise<void>>();
  #written = 0;
  #failed = 0;
  #lastFailure: string | null = null;

  constructor(sink: AuditSink) {
    this.#sink = sink;
  }

  /**
   * Takes one update. **Never throws** (ADR-033).
   *
   * A broken audit sink must not take a session down, so a write failure is counted
   * and remembered rather than propagated. It is not swallowed either: `summary()`
   * and `close()` report it, because an audit that fails silently is worse than none
   * — it looks like evidence.
   */
  accept(update: EventLike): void {
    try {
      switch (update.type) {
        case 'policy.decided': {
          if (update.callId !== undefined && update.decision !== undefined) {
            this.#pending.set(update.callId, { verdict: update.decision.verdict, rule: update.decision.rule, approval: null });
          }
          return;
        }
        case 'approval.answered': {
          const pending = update.callId === undefined ? undefined : this.#pending.get(update.callId);
          if (pending !== undefined && update.verdict !== undefined && update.by !== undefined) {
            pending.approval = { verdict: update.verdict, by: update.by };
          }
          return;
        }
        case 'tool.finished': {
          if (update.callId === undefined) return;
          const pending = this.#pending.get(update.callId);
          this.#pending.delete(update.callId);
          // Without a decision there is nothing to audit — an event stream that
          // starts mid-call has no verdict to report, and inventing one is worse
          // than saying nothing.
          if (pending === undefined) return;
          this.#write({
            sessionId: update.sessionId,
            turnId: update.turnId,
            seq: update.seq,
            ts: update.ts,
            callId: update.callId,
            tool: update.name ?? '',
            verdict: pending.verdict,
            rule: pending.rule,
            approval: pending.approval,
            ok: update.ok ?? false,
            sandbox: update.facts?.sandbox ?? null,
            termination: update.facts?.termination ?? null,
            removedEnv: update.facts?.removedEnv ?? [],
            ignoredDeny: update.facts?.ignoredDeny ?? [],
          });
          return;
        }
        default:
          // Stream deltas are not facts, and the rest of the log is not this
          // consumer's business.
          return;
      }
    } catch (error) {
      // Defensive: the switch above cannot throw today, but `accept` is called from
      // the session's listener loop, where a throw would interrupt the other
      // listeners. Counted like a write failure rather than propagated.
      this.#failed++;
      this.#lastFailure = message(error);
    }
  }

  /** A snapshot of what has been written so far. In-flight writes are not counted yet. */
  summary(): AuditSummary {
    return { written: this.#written, failed: this.#failed, inFlight: this.#inFlight.size, lastFailure: this.#lastFailure };
  }

  /**
   * Waits for the writes still in flight and returns the final summary.
   *
   * The session-end report needs this: `accept` returns immediately, so without
   * awaiting, a report could claim zero failures while a write was still failing.
   */
  async close(): Promise<AuditSummary> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
    return this.summary();
  }

  #write(record: AuditRecord): void {
    const inFlight = this.#sink.write(record).then(
      () => {
        this.#written++;
      },
      (error: unknown) => {
        this.#failed++;
        this.#lastFailure = message(error);
      },
    );
    this.#inFlight.add(inFlight);
    void inFlight.finally(() => {
      this.#inFlight.delete(inFlight);
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
