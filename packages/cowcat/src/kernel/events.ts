import type { ApprovalBy, ApprovalVerdict } from '../policy/approval.js';
import type { Decision } from '../policy/decide.js';
import type { Attachment, BackgroundEndState, SkillLayer, SkillOrigin, TerminationReason, ToolOutputStream, Truncation, TodoItem } from '../ports/index.js';import type { ModelUsage, StopReason } from '../ports/model.js';
import type { SubagentRole, SubagentState } from '../ports/subagent.js';
import type { ExecutionFacts } from '../ports/process.js';
import type { SessionShell } from '../ports/platform.js';
import type { ToolCall, ReasoningBlock } from './messages.js';
import type { PriceTable } from './preset.js';
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
 * One skill whose name made it into the catalog (ADR-116 ①).
 *
 * The path is deliberately absent: a replay only has to reproduce the text the model was
 * shown, and the catalog names no paths. `doctor` reports paths from live discovery.
 */
export interface SkillSource {
  readonly name: string;
  readonly layer: SkillLayer;
  readonly origin: SkillOrigin;
  /** UTF-8 bytes of the line this skill contributed. */
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
  /** `fork` is set by session forking (ADR-127); subagent logic never reads it. */
  readonly role: SubagentRole | 'fork';
}

// Durable facts. Anything in this union is written to the session log before it
// is applied to state, so replaying the log reproduces the session exactly.
export type KernelEvent = EventBase &
  (
    | { readonly type: 'session.opened'; readonly schemaVersion: number; readonly cowcatVersion: string; readonly shell: SessionShell; readonly parent?: SessionParent | undefined; /**
     * Where and as-whom the session started (ADR-126). Optional for the same reason
     * `parent` is: every log written before this header field existed decodes as "not
     * recorded", which is the truth. `model` is the creating preset; the per-turn truth
     * stays on `turn.opened`.
     */
    readonly cwd?: string | undefined; readonly model?: string | undefined }
    | {
        readonly type: 'turn.opened';
        readonly input: string;
        /**
         * The model this turn runs on (ADR-102). Optional because logs written before the
         * field existed are still valid, and a status bar that cannot say which model ran a
         * turn is guessing.
         */
        readonly model?: string | undefined;
        /**
         * The preset's context window for this turn (ADR-105). Optional for the same reason
         * `model` is, plus one of its own: a preset may declare no window, and then nothing
         * local can say how full the context is.
         */
        readonly contextWindow?: number | undefined;
        /**
         * What the running preset costs (ADR-131 ②), for the meter to price the turn.
         * Optional: a preset may declare no price, and every log written before this
         * field existed is still honest about what it does not know.
         */
        readonly price?: PriceTable | undefined;
      }
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
    | {
        /**
         * The skill catalog the model is now being sent (ADR-116 ①).
         *
         * A message-producing event for the same reason `instructions.loaded` is: what the
         * model was told about the skills available to it is part of the conversation, and
         * a replay that had to re-read the filesystem could show a different catalog than
         * the one the model actually saw. `text` is the rendered catalog, so replay needs
         * nothing on disk.
         *
         * `trigger` mirrors the instruction event: `start` on the first injection of the
         * session, `refresh` when a compaction shadowed the previous one (ADR-116 ④).
         */
        readonly type: 'skills.loaded';
        readonly trigger: 'start' | 'refresh';
        readonly text: string;
        /** Which names made it into `text`, and how much of the budget each took. */
        readonly skills: readonly SkillSource[];
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
        /**
         * The exact subject under review (ADR-129 (7)): the command text or canonical
         * path the grant key is computed from — the SAME value, so the card renders
         * precisely what an answer grants. Absent on every log written before
         * ADR-129, and on questions (like TodoWrite) that have neither.
         */
        readonly command?: string | undefined;
        readonly path?: string | undefined;
        /**
         * What this approval would widen, listed for the card (ADR-129 (7)): a
         * `deny-override` lets this exact action through its rule's deny; `unsandboxed`
         * runs this one command without the sandbox (ADR-130). Absent = the plain ask
         * question, which widens nothing by itself.
         */
        readonly dimensions?: readonly ('deny-override' | 'unsandboxed')[] | undefined;
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
        readonly type: 'approval.revoked';
        readonly key: string;
        readonly by: 'user';
      }
    | {
        /**
         * An Escalate appeal a user approved (ADR-129): the right to retry one exact
         * subject past a `deny` (`deny-override`) or without the sandbox (`unsandboxed`).
         * Kept apart from `grants` on purpose: grants feed the `ask` path, and letting an
         * escalation once-grant auto-answer an unrelated `ask` would widen it silently.
         * `scope: 'once'` burns on first use (`escalation.consumed`); `'always'` stands
         * for the session, exact subject only.
         */
        readonly type: 'escalation.granted';
        readonly callId: string;
        readonly key: string;
        readonly scope: 'once' | 'always';
        readonly dimension: 'deny-override' | 'unsandboxed';
      }
    | {
        /** A `once` escalation grant was exercised; the retry it bought is spent (ADR-129 (4)). */
        readonly type: 'escalation.consumed';
        readonly callId: string;
        readonly key: string;
        readonly dimension: 'deny-override' | 'unsandboxed';
      }
    | {
        readonly type: 'file.changed';
        readonly callId: string;
        readonly path: string;
        readonly beforePath: string;
        readonly created: boolean;
        readonly beforeHash?: string | null | undefined;
        readonly afterHash?: string | null | undefined;
      }
    | {
        readonly type: 'file.reverted';
        readonly callId: string;
        readonly path: string;
        readonly redoPath: string;
      }
    | {
        readonly type: 'file.restored';
        readonly callId: string;
        readonly path: string;
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
         * A repeat-call reminder the model was shown (ADR-120).
         *
         * A message-producing event for the same reason `instructions.loaded` is: the
         * warning is part of the conversation, and a replay has to show the model the
         * same text without re-deriving whether the call looked repetitive. `text` is
         * the rendered reminder (deterministic: name and count only).
         *
         * Emitted after the repeated call's `tool.finished`, so the model reads the
         * fresh result first and the warning second.
         */
        readonly type: 'tool.repeat-detected';
        readonly turnId: string | null;
        readonly callId: string;
        readonly name: string;
        /** How many consecutive identical calls this one is (2 = the second). */
        readonly count: number;
        readonly text: string;
      }
    | {
        /**
         * Context a hook injected through `additionalContext` (ADR-122 ④).
         *
         * A message-producing event for the same reason `instructions.loaded` is: the
         * text is part of the conversation, and a replay has to show the model the same
         * context without re-running the hook. Emitted before `turn.opened` when the
         * hook fired on the prompt, so the model reads hook context ahead of the request
         * — the same ordering instructions follow (ADR-078 ①).
         */
        readonly type: 'hooks.context-added';
        readonly turnId: string | null;
        readonly text: string;
      }
    | {
        /**
         * `@` file references the user attached to their prompt (ADR-128). A
         * message-producing event like `hooks.context-added`: the content is part of
         * the conversation, so replay reproduces it without touching the disk. Emitted
         * by the host before the turn opens, so the model reads the files ahead of the
         * instruction that references them.
         */
        readonly type: 'prompt.attached';
        readonly turnId: string | null;
        readonly files: readonly { readonly name: string; readonly content: string }[];
      }
    | {
        /**
         * Plan mode toggled (ADR-124). `by: 'user'` is a person flipping the switch
         * (TUI `/plan`, protocol `plan.setMode`); `'plan-approved'` is the automatic
         * exit after the person picks a plan. Folded into `SessionState.planMode`.
         */
        readonly type: 'plan.mode-changed';
        readonly turnId: string | null;
        readonly enabled: boolean;
        readonly by: 'user' | 'plan-approved';
      }
    | {
        /**
         * An `ExitPlan` call presented its plans to the person (ADR-125). A fact, not a
         * message: the frontends render the card from this event, and replay reproduces
         * what was offered without re-running anything.
         */
        readonly type: 'plan.proposed';
        readonly turnId: string | null;
        readonly callId: string;
        readonly plans: readonly { readonly title: string; readonly summary: string }[];
      }
    | {
        /**
         * The person's answer to a plan review (ADR-125). `choice` is the picked plan's
         * index, or `null` when none of them qualified (`reason` says why).
         */
        readonly type: 'plan.decided';
        readonly turnId: string | null;
        readonly callId: string;
        readonly choice: number | null;
        readonly reason: string | null;
      }
    | {
        /**
         * A background task started by this call (ADR-111).
         *
         * Durable, and paired with `tool.background.finished`: an ephemeral start would
         * vanish on replay, leaving a process nobody can account for. The task itself is
         * the host's registry; this is the fact that it existed.
         */
        readonly type: 'tool.background.started';
        readonly callId: string;
        readonly taskId: string;
        readonly command: string;
      }
    | {
        /**
         * A background task ended (ADR-111). `state` is the registry's word, not a guess:
         * `lost` means the host could not prove the process tree was gone.
         */
        readonly type: 'tool.background.finished';
        readonly callId: string;
        readonly taskId: string;
        readonly exitCode: number | null;
        readonly signal: string | null;
        readonly state: BackgroundEndState;
        /** Why the gateway stopped it (`none` when it exited on its own). */
        readonly reason: TerminationReason;
        /** What the gateway actually did; `null` only when no result was produced (ADR-033). */
        readonly facts: ExecutionFacts | null;
        /** The tail the registry kept; empty when the task never produced output. */
        readonly tail: string;
        readonly truncated: boolean;
        readonly dropped: number;
      }
    | {
        /**
         * A cron job was created (ADR-140). The job table is a projection of these
         * events, not host state, so resume replays it for free — the structural fix
         * for the legacy crons.json drift and cross-session misfires.
         */
        readonly type: 'cron.created';
        readonly jobId: string;
        readonly schedule: string;
        readonly prompt: string;
        readonly recurring: boolean;
        readonly createdAt: number;
        /** Recurring jobs expire (ADR-141 ⑤); `null` on one-shot jobs. */
        readonly expiresAt: number | null;
      }
    | {
        /**
         * A cron job was deleted (ADR-140). `by` records who ended it: the user from
         * the `/cron` panel, the model via CronDelete, or 'expiry' after the final
         * fire of a recurring job's 7-day life (ADR-141 ⑤).
         */
        readonly type: 'cron.deleted';
        readonly jobId: string;
        readonly by: 'user' | 'model' | 'expiry';
        readonly deletedAt: number;
      }
    | {
        /**
         * A cron job was handed to the scheduler (ADR-140 ②). Written when the turn
         * is enqueued, with the turnId minted up front; a fired event whose turn
         * never opened reads as "enqueued, not executed", never as silence.
         */
        readonly type: 'cron.fired';
        readonly jobId: string;
        readonly turnId: string;
        readonly firedAt: number;
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
  | 'skills-skipped'
  | 'rounds-exhausted'
  | 'hook-failed'
  | 'queue-failed';

// Ephemeral updates exist for live rendering only. They are never persisted:
// a streamed token is not a fact about the session, the final model.message is.
export interface StreamDelta {
  readonly type: 'model.delta';
  readonly turnId: string;
  readonly text: string;
}

/**
 * A live fragment of the model's thinking (ADR-098).
 *
 * Ephemeral for the same reason as `model.delta`: a fragment is not a fact — the complete
 * block in `model.message.reasoning` is. It exists so the screen can show thinking while
 * it happens instead of after the block closes.
 */
export interface ReasoningDelta {
  readonly type: 'reasoning.delta';
  readonly turnId: string;
  readonly text: string;
}

/**
 * A live fragment of a tool's output while the call is still running (ADR-108).
 *
 * Ephemeral for the same reason as the two above: the complete output lands in
 * `tool.finished.output`, so a fragment is not a fact. `callId` is what lets a renderer
 * attach it to the card that is still running; filtering by it is the frontend's job.
 */
export interface ToolOutputDelta {
  readonly type: 'tool.output.delta';
  readonly turnId: string;
  readonly callId: string;
  readonly stream: ToolOutputStream;
  readonly text: string;
}

export type SessionUpdate = KernelEvent | StreamDelta | ReasoningDelta | ToolOutputDelta;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EventInput = DistributiveOmit<KernelEvent, 'seq' | 'ts' | 'sessionId'>;

export interface AttachedFile {
  readonly name: string;
  readonly content: string;
}

/** The user message an `prompt.attached` event folds into. Deterministic by construction. */
export function formatAttachedFiles(files: readonly AttachedFile[]): string {
  const parts = files.map((file) => [`--- ${file.name} ---`, file.content].join('\n'));
  return ['The user attached the following files. Read them before answering:', '', ...parts].join('\n\n');
}
