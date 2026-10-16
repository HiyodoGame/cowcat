import type { Decision } from '../policy/decide.js';
import type { ToolCall } from './messages.js';
import type { TurnState } from './turn.js';

interface EventBase {
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly turnId: string | null;
}

// Durable facts. Anything in this union is written to the session log before it
// is applied to state, so replaying the log reproduces the session exactly.
export type KernelEvent = EventBase &
  (
    | { readonly type: 'turn.opened'; readonly input: string }
    | { readonly type: 'turn.transitioned'; readonly from: TurnState; readonly to: TurnState; readonly reason: string | null }
    | { readonly type: 'model.message'; readonly text: string; readonly toolCalls: readonly ToolCall[] }
    | { readonly type: 'policy.decided'; readonly callId: string; readonly decision: Decision }
    | { readonly type: 'tool.finished'; readonly callId: string; readonly ok: boolean; readonly output: string }
  );

export type KernelEventType = KernelEvent['type'];

// Ephemeral updates exist for live rendering only. They are never persisted:
// a streamed token is not a fact about the session, the final model.message is.
export interface StreamDelta {
  readonly type: 'model.delta';
  readonly turnId: string;
  readonly text: string;
}

export type SessionUpdate = KernelEvent | StreamDelta;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EventInput = DistributiveOmit<KernelEvent, 'seq' | 'ts' | 'sessionId'>;
