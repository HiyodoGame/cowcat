import type { ApprovalBy, ApprovalVerdict } from '../policy/approval.js';
import type { Decision } from '../policy/decide.js';
import type { ExecutionFacts } from '../ports/process.js';
import type { SessionShell } from '../ports/platform.js';
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
    | { readonly type: 'session.opened'; readonly schemaVersion: number; readonly cowcatVersion: string; readonly shell: SessionShell }
    | { readonly type: 'turn.opened'; readonly input: string }
    | { readonly type: 'turn.transitioned'; readonly from: TurnState; readonly to: TurnState; readonly reason: string | null }
    | { readonly type: 'model.message'; readonly text: string; readonly toolCalls: readonly ToolCall[] }
    | { readonly type: 'policy.decided'; readonly callId: string; readonly decision: Decision }
    | {
        // Written before the question is asked, so a log that ends inside an approval
        // says what was being asked rather than leaving a hole.
        readonly type: 'approval.requested';
        readonly callId: string;
        readonly name: string;
        readonly rule: string;
        readonly reason: string | null;
      }
    | {
        // `key` is what an `always` answer grants, and it is recorded on the ANSWER
        // rather than looked up from the request: `reduce` sees one event at a time,
        // and a grant that could only be reconstructed by walking backwards is a
        // grant that replay would get wrong.
        readonly type: 'approval.answered';
        readonly callId: string;
        readonly key: string;
        readonly verdict: ApprovalVerdict;
        readonly by: ApprovalBy;
      }
    | {
        readonly type: 'tool.finished';
        readonly callId: string;
        readonly name: string;
        readonly ok: boolean;
        readonly output: string;
        /**
         * What the execution gateway actually did, when the tool ran a process
         * (ADR-033). `null` means the tool reported NOTHING — an audit has to record
         * that as "not known", never as "no sandbox".
         */
        readonly facts: ExecutionFacts | null;
      }
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
