import type { KernelEvent } from '../kernel/events.js';
import type { Message, ToolCall } from '../kernel/messages.js';

export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
}

export interface ToolPort {
  readonly spec: ToolSpec;
  run(input: unknown, signal: AbortSignal): Promise<ToolResult>;
}

export type ModelChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall };

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
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
