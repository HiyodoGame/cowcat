import type { ApprovalBy, ApprovalVerdict } from '../policy/approval.js';
import type { Decision } from '../policy/decide.js';
import type { Truncation, TodoItem } from '../ports/index.js';
import type { ModelUsage, StopReason } from '../ports/model.js';
import type { ExecutionFacts } from '../ports/process.js';
import type { SessionShell } from '../ports/platform.js';
import type { ToolCall, ReasoningBlock } from './messages.js';
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
    | {
        readonly type: 'model.message';
        readonly text: string;
        readonly toolCalls: readonly ToolCall[];
        /**
         * The reasoning the model produced on the way to the answer (ADR-045), kept as
         * replayable blocks rather than a string: at least one protocol requires them to
         * go back **unmodified, in order, signature intact**.
         *
         * Required and possibly empty, like `toolCalls`: "the model did not think out
         * loud" and "we dropped it" are different statements, and only one of them is
         * true here.
         */
        readonly reasoning: readonly ReasoningBlock[];
        /**
         * Why the stream ended (ADR-035). `null` means the adapter did not report one.
         *
         * It is logged rather than kept in memory because "the answer stopped because
         * it ran out of room" is a fact a user has to be able to learn from the
         * session, not only from the moment it happened (`finish_reason: 'length'`
         * with empty content is a real failure mode).
         */
        readonly stopReason: StopReason | null;
      }
    | {
        /**
         * What the model call cost (ADR-041). A separate event rather than a field on
         * `model.message`, for two reasons: usage arrives before the stream ends
         * (Anthropic reports it on `message_delta`), and a turn that is cancelled
         * after usage has arrived still has to record it.
         */
        readonly type: 'model.usage';
        readonly usage: ModelUsage;
      }
    | { readonly type: 'policy.decided'; readonly callId: string; readonly decision: Decision }
    | {
        /**
         * The session's todo list, replaced wholesale (ADR-054). Full replacement, not a
         * delta: what the model sent is the complete new state, so replay never has to
         * merge two lists to find out what the user saw.
         *
         * It is an event rather than a field on `tool.finished` for the same reason
         * `model.usage` is: the list is a fact about the session, not about the call
         * that produced it — and the ordering is chosen so a crash between the two
         * appends leaves the list recorded rather than silently lost.
         */
        readonly type: 'todo.updated';
        readonly todos: readonly TodoItem[];
      }
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
        /**
         * What a cap left out of `output` (ADR-048), or `null` when the tool reported
         * nothing — the same statement `facts` makes, for the same reason.
         */
        readonly truncation: Truncation | null;
        /**
         * The canonical path this call acted on, when its spec declared a `pathInput`
         * (ADR-049). `null` when it declared none, or the input carried no usable value.
         *
         * It is logged because `reduce` rebuilds the "read before write" gate from it: a
         * set held beside the log would make that rule silently vanish once the session
         * is reopened (the legacy `ctx.readSet` did exactly that).
         */
        readonly path: string | null;
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
