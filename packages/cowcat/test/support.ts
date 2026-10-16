import type { KernelEvent } from '../src/kernel/events.js';
import { LockHeldError, type ModelChunk, type ModelPort, type ModelRequest, type EventStore, type Clock, type IdSource, type ToolPort, type ToolSpec, type ToolResult, type SessionDeps, type LockPort, type SessionSnapshot, type SnapshotPort } from '../src/index.js';

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
