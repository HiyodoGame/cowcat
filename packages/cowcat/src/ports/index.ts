import type { KernelEvent } from '../kernel/events.js';
import type { Message, ToolCall } from '../kernel/messages.js';
import type { SessionState } from '../kernel/state.js';
import type { ModelUsage, StopReason } from './model.js';
import type { ExecutionFacts } from './process.js';

// The ports live in their own files (docs/architecture/01-layers.md) and are
// re-exported here, so this barrel stays the single import surface for the kernel
// and the tests.
export * from './audit.js';
export * from './fs.js';
export * from './instructions.js';
export * from './model.js';
export * from './platform.js';
export * from './process.js';
export * from './trust.js';

export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  /**
   * Input field names that carry the two things a rule may narrow on. The kernel
   * reads them to build the `ActionRequest` (ADR-027) — a tool that writes a file
   * says `pathInput: 'file_path'`, one that runs a command says
   * `commandInput: 'command'`. Absent means the action has no path/command, so a
   * rule that selects on one simply does not match.
   *
   * Kept as two field names rather than a per-tool descriptor method so the
   * declaration stays data: the risk level is declared the same way, and the
   * kernel can read it without knowing any particular tool.
   */
  readonly pathInput?: string;
  readonly commandInput?: string;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  /**
   * What the execution gateway actually did, when this tool ran a process
   * (ADR-033). Absent means the tool reported NOTHING — which an audit has to record
   * as "not known", never as "no sandbox". The difference between those two is the
   * whole point of an audit trail.
   */
  readonly facts?: ExecutionFacts;
}

export interface ToolPort {
  readonly spec: ToolSpec;
  run(input: unknown, signal: AbortSignal): Promise<ToolResult>;
}

export type ModelChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | {
      /**
       * Emitted when the adapter has numbers to report, which is not the same as
       * "once per stream": most streaming chunks carry no usage at all, and Anthropic
       * reports it twice (an initial count, then a cumulative one). A consumer that
       * wants a single figure takes the last one (ADR-040).
       */
      readonly type: 'usage';
      readonly usage: ModelUsage;
    }
  | {
      /**
       * What the stream ended on. Deliberately NOT what decides that the stream has
       * ended: providers disagree about whether a usage-only chunk or `[DONE]`
       * follows the finishing chunk, and some keep sending tool-call deltas after it
       * (`agent/src/llm/openai.js:69-71`). The end of the iterator is the end.
       */
      readonly type: 'stop';
      readonly reason: StopReason;
    };

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  /**
   * Which model to call. The kernel knows it, because "which model" is a decision the
   * session made, not something an adapter may guess (ADR-035).
   */
  readonly model: string;
  /**
   * Instructions that go ahead of the conversation. A request field rather than a
   * `Message`, because the two protocols disagree about where it lives: Anthropic
   * takes a top-level `system`, OpenAI takes a `role: 'system'` message — and the
   * internal `Message` union has no such role (ADR-035).
   */
  readonly system?: string;
  /** An override; a model's own ceiling comes from its preset (ADR-037). */
  readonly maxTokens?: number;
  /**
   * Vendor extensions (ADR-038). A named escape hatch rather than a free-form bag on
   * the request itself; an adapter sends only what a preset declared, because guessing
   * a default either 400s (MiniMax rejects `reasoning_effort: 'none'`) or is silently
   * ignored.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

export interface EventStore {
  append(event: KernelEvent): Promise<void>;
  readAll(sessionId: string): Promise<readonly KernelEvent[]>;
}

export interface Clock {
  now(): number;
}

export interface IdSource {
  next(prefix: string): string;
}

// A session is single-writer, and the lock is held for the whole life of the
// Session — not for the duration of a single append (ADR-010). `EventStore` stays
// unaware of it: the lock is a separate port so a memory store need not fake it.
export interface SessionLock {
  release(): Promise<void>;
}

export interface LockPort {
  acquire(sessionId: string): Promise<SessionLock>;
}

// Snapshots accelerate replay; they are never a source of truth. `load` answers null
// when there is no snapshot *or* when it cannot be used, because both mean the same
// thing to the caller: replay the log (ADR-013).
export interface SessionSnapshot {
  readonly schemaVersion: number;
  readonly lastSeq: number;
  readonly state: SessionState;
}

export interface SnapshotPort {
  load(sessionId: string): Promise<SessionSnapshot | null>;
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;
}

// Thrown when acquire() cannot claim the session. The fields let a frontend render
// recovery guidance without parsing the message. Ports deliberately expose no
// "is it locked?" query: callers must go through acquire, not around it.
export class LockHeldError extends Error {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly lockPath: string;
  readonly guidance: string;

  constructor(sessionId: string, lockPath: string, pid: number | null, guidance: string) {
    super(`session ${sessionId} is locked: ${guidance}`);
    this.name = 'LockHeldError';
    this.sessionId = sessionId;
    this.pid = pid;
    this.lockPath = lockPath;
    this.guidance = guidance;
  }
}
