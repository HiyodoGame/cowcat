import type { KernelEvent } from '../src/kernel/events.js';
import { LockHeldError, DEFAULT_RULES, type ActionRequest, type ApprovalVerdict, type Decision, type FsPort, type ModelChunk, type ModelPort, type ModelPreset, type ModelRequest, type EventStore, type Clock, type IdSource, type Rule, type Session, type SubagentPort, type ToolGrant, type ToolPort, type ToolSpec, type ToolResult, type SessionDeps, type TurnDeps, type LockPort, type SessionShell, type SessionSnapshot, type SnapshotPort, type InstructionNeeds } from '../src/index.js';

export class MemoryEventStore implements EventStore {
  readonly events: KernelEvent[] = [];

  async append(event: KernelEvent): Promise<void> {
    this.events.push(event);
  }

  async readAll(sessionId: string): Promise<readonly KernelEvent[]> {
    return this.events.filter((e) => e.sessionId === sessionId);
  }
}

export function fixedClock(start = 1_000): Clock {
  let t = start;
  return { now: () => (t += 1) };
}

export function sequentialIds(): IdSource {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n)}`;
    },
  };
}

// A session in a test rarely contends with anyone, so the default lock never
// refuses. exclusiveLock() is the one that mirrors real EEXIST behaviour.
export function noopLock(): LockPort {
  return { acquire: () => Promise.resolve({ release: () => Promise.resolve() }) };
}

// In-process stand-in for the file lock: the second acquire of the same session id
// fails the way EEXIST does, so LockHeldError paths need no disk.
export function exclusiveLock(): LockPort {
  const held = new Set<string>();
  return {
    acquire: (sessionId) => {
      if (held.has(sessionId)) {
        return Promise.reject(
          new LockHeldError(sessionId, `<memory>/${sessionId}.jsonl.lock`, null, 'held by this process'),
        );
      }
      held.add(sessionId);
      return Promise.resolve({
        release: () => {
          held.delete(sessionId);
          return Promise.resolve();
        },
      });
    },
  };
}

export interface SessionDepsOptions {
  readonly cowcatVersion?: string;
  readonly shell?: SessionShell;
  readonly lock?: LockPort;
  readonly snapshots?: SnapshotPort;
}

// Snapshots are an accelerator, so the default double simply has none: sessions in
// tests replay in full, exactly as before T4.
export function noopSnapshots(): SnapshotPort {
  return {
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
  };
}

// Hands back exactly the snapshot it was given, for tests about the *decision* to use
// one rather than about the file format.
export function snapshotsReturning(snapshot: SessionSnapshot | null): SnapshotPort {
  return {
    load: () => Promise.resolve(snapshot),
    save: () => Promise.resolve(),
  };
}

// One place to build SessionDeps: it grows with each P1 task (cowcatVersion, then the
// lock, then snapshots) and tests should not each carry the whole shape.
export function sessionDeps(store: EventStore, options: SessionDepsOptions = {}): SessionDeps {
  return {
    store,
    clock: fixedClock(),
    ids: sequentialIds(),
    lock: options.lock ?? noopLock(),
    snapshots: options.snapshots ?? noopSnapshots(),
    cowcatVersion: options.cowcatVersion ?? '0.0.0-test',
    // A fact the kernel records but never decides: tests about the kernel should not
    // have to know where any shell lives.
    shell: options.shell ?? { kind: 'posix', executable: '/bin/sh' },
  };
}

// Each entry is what one model call yields. The requests it received are kept
// so tests can assert what the model was actually shown.
export class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly #script: ReadonlyArray<readonly ModelChunk[] | Error>;

  constructor(script: ReadonlyArray<readonly ModelChunk[] | Error>) {
    this.#script = script;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    const step = this.#script[this.requests.length - 1];
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    for (const chunk of step) {
      if (signal.aborted) return;
      yield chunk;
    }
  }
}

export function tool(
  spec: ToolSpec,
  run: (input: unknown, grant: ToolGrant) => ToolResult | Promise<ToolResult>,
): ToolPort {
  // The signal is forwarded only so a double that wants it can take a third parameter;
  // most tests care about the input, and some about what was granted (ADR-051).
  return { spec, run: async (input, _signal, grant) => run(input, grant) };
}

export interface TurnDepsOptions {
  readonly tools?: ReadonlyMap<string, ToolPort>;
  readonly rules?: readonly Rule[];
  readonly approve?: (request: ActionRequest, decision: Decision) => Promise<ApprovalVerdict>;
  readonly fs?: FsPort;
  readonly approvalTimeoutMs?: number;
  /**
   * Overrides for the test preset (ADR-046). The default can do everything, so a test
   * that is about something else never has to build a whole `ModelPreset`; a test about
   * the preset itself passes exactly the fields it means.
   */
  readonly preset?: Partial<ModelPreset>;
  readonly effort?: string;
  /** Workspace instructions (ADR-078); omitted means the turn runs without them. */
  readonly instructions?: InstructionNeeds;
  /** Delegation (ADR-079). Omitted means `Task` is never offered to the model. */
  readonly subagents?: { readonly port: SubagentPort };
  /** Why approvals cannot be answered here (ADR-081 ③). */
  readonly unattended?: string;
}

// One place to build TurnDeps, for the same reason sessionDeps exists: the shape
// grows with each task (P3 T1 added rules, T2 added fs) and tests should not each
// carry the whole thing. `approve` defaults to "yes" because most tests are not
// about approval; the ones that are pass their own.
export function turnDeps(session: Session, model: ModelPort, options: TurnDepsOptions = {}): TurnDeps {
  return {
    session,
    model,
    // A preset the kernel only relays (ADR-046). Tests that care about what the adapter
    // was asked for assert on ScriptedModel.requests, not on this default. The ceiling
    // is arbitrary — it exists so a protocol that requires one is satisfiable from the
    // default without every test restating it.
    preset: {
      protocol: 'openai',
      model: 'test-model',
      limits: { output: 1024 },
      toolCalls: true,
      ...options.preset,
    },
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.subagents === undefined ? {} : { subagents: options.subagents }),
    ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
    tools: options.tools ?? new Map(),
    rules: options.rules ?? DEFAULT_RULES,
    fs: options.fs ?? fakeFs(),
    approve: options.approve ?? (() => Promise.resolve('once')),
    ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
    ids: sequentialIds(),
  };
}

// A canonical() that touches no filesystem, so kernel tests stay runtime-agnostic.
// It normalises separators and records what it was asked — which is what a kernel
// test actually needs to assert: that the path reached FsPort at all. Path identity
// itself is src/adapters/fs.ts and is tested there.
export function fakeFs(): FsPort & { readonly canonicalCalls: readonly string[] } {
  const calls: string[] = [];
  return {
    canonical(path) {
      calls.push(path);
      const normalised = path.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalised === '' ? '/' : normalised;
    },
    samePath: (a, b) => a.replace(/\\/g, '/') === b.replace(/\\/g, '/'),
    kindOf: () => null,
    exists: () => false,
    get canonicalCalls() {
      return calls;
    },
  };
}

/**
 * A transport that answers with the bytes it was given and records what it was asked
 * (ADR-042).
 *
 * The bytes are the test's business; feeding them through the *real* SDK is the point —
 * a stubbed client would test our idea of the protocol instead of the protocol, which is
 * where the differences actually live.
 */
export interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | null | undefined;
}

export interface ReplayTransport {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
}

export function replayTransport(raw: string): ReplayTransport {
  const requests: RecordedRequest[] = [];
  const impl = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const [input, init] = args;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url: urlOf(input), body, signal: init?.signal });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { fetch: impl, requests };
}

// The SDKs pass a plain URL string; the other shapes are here for completeness rather
// than because either adapter has been seen to use them.
function urlOf(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A transport whose response body never closes, so cancellation can be observed.
 *
 * It errors the body when the signal it was handed aborts, because that is what a real
 * `fetch` does — and it is the whole mechanism behind counting a stream as cancelled:
 *
 * - **Neither SDK hands the caller's own signal to `fetch`.** Both bridge it, so an
 *   identity check (`passed === caller.signal`) is false for both and testing it would
 *   be testing the wrong thing.
 * - **The bridge is torn down when the request ends.** So "the signal `fetch` holds is
 *   aborted" is only observable while the request is still in flight; asserting it after
 *   a completed request measures teardown, not cancellation.
 */
export function openEndedTransport(firstBytes: string): ReplayTransport {
  const requests: RecordedRequest[] = [];
  const impl = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const [input, init] = args;
    requests.push({ url: urlOf(input), body: {}, signal: init?.signal });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstBytes));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
      // deliberately never closed
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { fetch: impl, requests };
}

/**
 * True when the promise settles (either way) within the deadline. Used to assert that a
 * cancellation *takes effect* rather than to expect a particular ending: the kernel
 * treats "the stream stopped" as the fact, and `run-turn` decides cancelled-vs-completed
 * from the signal itself.
 */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = promise.then(
    () => true,
    () => true,
  );
  return Promise.race([settled, deadlineAfter(ms)]);
}

function deadlineAfter(ms: number): Promise<boolean> {
  // Braces on purpose: `resolve` returns void, and returning a void expression from an
  // arrow shorthand is what no-confusing-void-expression objects to.
  return new Promise<boolean>((resolve) => {
    setTimeout(() => {
      resolve(false);
    }, ms);
  });
}

export interface SequenceStep {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** The body; for a stream step this is the SSE text. */
  readonly body: string;
}

/**
 * Hands out one response per request, in order — the shape a retry test needs, since the
 * whole point is that the second request is answered differently from the first. The last
 * step is repeated if anything asks for more.
 */
export function sequenceTransport(steps: readonly SequenceStep[]): ReplayTransport {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const impl = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const [input, init] = args;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url: urlOf(input), body, signal: init?.signal });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) return Promise.reject(new Error('sequenceTransport: no steps'));
    return Promise.resolve(
      new Response(step.body, { status: step.status, headers: step.headers ?? {} }),
    );
  };
  return { fetch: impl, requests };
}

/**
 * A 200 whose body yields the given bytes and then fails. The case ADR-039 decision ③ is
 * about: output has already left the building, so a retry would make the model say it
 * again.
 */
export function failingBodyTransport(firstBytes: string): ReplayTransport {
  const requests: RecordedRequest[] = [];
  const impl = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const [input, init] = args;
    requests.push({ url: urlOf(input), body: {}, signal: init?.signal });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstBytes));
        controller.error(new Error('the connection died mid-stream'));
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { fetch: impl, requests };
}
