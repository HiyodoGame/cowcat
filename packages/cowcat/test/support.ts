import type { KernelEvent } from '../src/kernel/events.js';
import { LockHeldError, DEFAULT_RULES, type ActionRequest, type ApprovalVerdict, type Decision, type FsPort, type ModelChunk, type ModelPort, type ModelRequest, type EventStore, type Clock, type IdSource, type Rule, type Session, type ToolPort, type ToolSpec, type ToolResult, type SessionDeps, type TurnDeps, type LockPort, type SessionShell, type SessionSnapshot, type SnapshotPort } from '../src/index.js';

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

export function tool(spec: ToolSpec, run: (input: unknown) => ToolResult | Promise<ToolResult>): ToolPort {
  return { spec, run: async (input) => run(input) };
}

export interface TurnDepsOptions {
  readonly tools?: ReadonlyMap<string, ToolPort>;
  readonly rules?: readonly Rule[];
  readonly approve?: (request: ActionRequest, decision: Decision) => Promise<ApprovalVerdict>;
  readonly fs?: FsPort;
  readonly approvalTimeoutMs?: number;
}

// One place to build TurnDeps, for the same reason sessionDeps exists: the shape
// grows with each task (P3 T1 added rules, T2 added fs) and tests should not each
// carry the whole thing. `approve` defaults to "yes" because most tests are not
// about approval; the ones that are pass their own.
export function turnDeps(session: Session, model: ModelPort, options: TurnDepsOptions = {}): TurnDeps {
  return {
    session,
    model,
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
