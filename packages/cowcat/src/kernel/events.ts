import type { ApprovalBy, ApprovalVerdict } from '../policy/approval.js';
import type { Decision } from '../policy/decide.js';
import type { Attachment, Truncation, TodoItem } from '../ports/index.js';
import type { ModelUsage, StopReason } from '../ports/model.js';
import type { SubagentRole, SubagentState } from '../ports/subagent.js';
import type { ExecutionFacts } from '../ports/process.js';
import type { SessionShell } from '../ports/platform.js';
import type { ToolCall, ReasoningBlock } from './messages.js';
import type { CompactionTrigger } from './context.js';
import type { TurnState } from './turn.js';

interface EventBase {
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly turnId: string | null;
}

/** One instruction file that made it into the injected text (ADR-078). */
export interface InstructionSource {
  readonly path: string;
  /** UTF-8 bytes after the budget was applied. */
  readonly bytes: number;
}

/**
 * Who delegated this session (ADR-079 ③).
 *
 * Optional on the header, and absent on every log written before delegation existed:
 * "no parent" is the shape of a top-level session, which is why the format did not need
 * a version bump.
 */
export interface SessionParent {
  readonly sessionId: string;
  readonly role: SubagentRole;
}

// Durable facts. Anything in this union is written to the session log before it
// is applied to state, so replaying the log reproduces the session exactly.
export type KernelEvent = EventBase &
  (
    | { readonly type: 'session.opened'; readonly schemaVersion: number; readonly cowcatVersion: string; readonly shell: SessionShell; readonly parent?: SessionParent | undefined }
    | { readonly type: 'turn.opened'; readonly input: string }
    | { readonly type: 'turn.transitioned'; readonly from: TurnState; readonly to: TurnState; readonly reason: string | null }
    | {
        /**
         * A static fact the turn ran under, recorded rather than only returned.
         *
         * These used to live only on `TurnOutcome.notes`, which every frontend dropped:
         * "we skipped your AGENTS.md" reached `doctor` and nothing else, which is the
         * silent failure ADR-030 exists to prevent. They are events now because a fact a
         * user has to be able to learn belongs in the log, not in a return value.
         *
         * `note` is the machine kind; `message` is the rendered line, kept here so a
         * replay needs no second renderer.
         */
        readonly type: 'turn.noted';
        readonly note: TurnNoteKind;
        readonly message: string;
      }
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
    | {
        /**
         * Older history replaced by a summary (ADR-071).
         *
         * The replaced events stay in the log — this is a fact about what the model is
         * *sent from now on*, not a deletion. `throughSeq` is the watermark: every
         * message whose originating event is at or below it stops being sent. Messages
         * after it are kept verbatim, which is what makes "keep the recent tail" a
         * property of the log rather than a copy of it.
         *
         * `shadowed` lists the exact seqs that stopped being sent, so an audit can tell
         * "which messages did this compaction hide" without re-deriving the fold.
         */
        readonly type: 'context.compacted';
        readonly trigger: CompactionTrigger;
        /** What the model sees instead, as one user message (ADR-069's discipline: say it, don't drop it). */
        readonly summary: string;
        /** The last shadowed event seq. 0 means "nothing was shadowed", which the kernel refuses to write. */
        readonly throughSeq: number;
        readonly shadowed: readonly number[];
        readonly dropped: number;
        /** Which model wrote the summary (audit; ADR-073 keeps it the session's own). */
        readonly model: string;
        /** What the summary call cost (ADR-041). `null` when the provider reported nothing. */
        readonly usage: ModelUsage | null;
      }
    | {
        /**
         * A compaction started (ADR-072). Paired with `context.compaction.finished`.
         *
         * The pair is a **lock in the log**, not in memory: a crash between them leaves an
         * unmatched start, which is detectable evidence rather than a session that
         * silently believes it is still compacting. Logged before the summary call, so a
         * process that dies mid-call does not look like one that never tried.
         */
        readonly type: 'context.compaction.started';
        readonly trigger: CompactionTrigger;
        readonly model: string;
      }
    | {
        /** The compaction attempt ended, successfully or not (ADR-072). */
        readonly type: 'context.compaction.finished';
        readonly ok: boolean;
        /** Why it failed, in the words the provider or the kernel used. `null` on success. */
        readonly error: string | null;
      }
    | {
        /**
         * The workspace instructions the model is now being sent (ADR-078).
         *
         * A message-producing event, like `turn.opened`: what the model is told about the
         * repository is part of the conversation it sees, and a session that cannot
         * replay it cannot answer "what was it actually told?". `text` is the rendered
         * chain (ADR-076), so a replay needs no filesystem at all.
         *
         * `trigger` says why it happened: `start` for the first injection of a session,
         * `refresh` when a compaction shadowed the previous one (ADR-078 ①).
         */
        readonly type: 'instructions.loaded';
        readonly trigger: 'start' | 'refresh';
        readonly text: string;
        /** What went into `text`, in the order it appears. Bytes are post-budget. */
        readonly files: readonly InstructionSource[];
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
        /**
         * What the command would cost if it went wrong (ADR-095). Absent when the tool
         * has no command or nothing matched — absent, not `null`, because every log
         * written before this field existed simply has no opinion to record.
         */
        readonly warning?: string | undefined;
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
        /**
         * Binary content this call produced, as references (ADR-057). `null` means the
         * tool reported NOTHING — the same statement `facts` and `truncation` make, and
         * the log records it rather than inferring it.
         *
         * It is logged because "this answer came with an image" is a durable fact: a
         * reopened session replays it into the tool message the model sees next, and a
         * frontend learns from it that there is something to fetch. The bytes never
         * travel this path (`attachment.read` is how a frontend asks for them).
         */
        readonly attachments: readonly Attachment[] | null;
      }
    | {
        /**
         * A delegated run started (ADR-079 ①).
         *
         * Written in the PARENT log, and before the child log is known to exist: the
         * child session id is minted first (ADR-080 ④), so a spawn that fails still
         * leaves a parent/child link rather than a delegation nobody can trace.
         */
        readonly type: 'subagent.started';
        readonly callId: string;
        readonly childSessionId: string;
        readonly role: SubagentRole;
        readonly description: string;
      }
    | {
        /**
         * The delegated run ended (ADR-079 ①), successfully or not.
         *
         * The child's own conversation is NOT here — it lives in the child's log. What
         * this event carries is what the parent needs to explain the delegation: how it
         * ended, how many rounds it took, whether the cap stopped it, and what it cost.
         *
         * `usage` is the child's total, kept apart from `model.usage` on purpose: the
         * parent's compaction trigger reads `lastUsage`, and folding a child's tokens in
         * would make the parent compact as if it had read them (ADR-082 ③).
         */
        readonly type: 'subagent.finished';
        readonly callId: string;
        readonly childSessionId: string;
        readonly role: SubagentRole;
        readonly ok: boolean;
        readonly state: SubagentState;
        readonly turns: number;
        readonly partial: boolean;
        readonly usage: ModelUsage | null;
        readonly reason: string | null;
      }
  );

export type KernelEventType = KernelEvent['type'];

/**
 * The kinds a turn can report about itself (ADR-046, ADR-072, ADR-082).
 *
 * Declared beside the event rather than derived from `TurnNote` so the log's vocabulary
 * is one list: a new note kind that is not added here cannot be recorded, which is the
 * check we want (an unrecordable note is the bug this event exists to fix).
 */
export type TurnNoteKind =
  | 'tools-unsupported'
  | 'effort-not-declared'
  | 'compaction-failed'
  | 'instructions-skipped'
  | 'rounds-exhausted';

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
