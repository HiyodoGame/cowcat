import type { KernelEvent } from '../src/kernel/events.js';
import type { ModelChunk, ModelPort, ModelRequest, EventStore, Clock, IdSource, ToolPort, ToolSpec, ToolResult } from '../src/index.js';

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
