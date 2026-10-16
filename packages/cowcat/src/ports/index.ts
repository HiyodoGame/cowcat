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
