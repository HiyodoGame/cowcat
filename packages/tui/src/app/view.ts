import type { Lang } from './copy.js';
import { detectLang } from './copy.js';

/**
 * The interface's own state — and the ONLY state this package holds (06-frontend.md).
 *
 * The session's state (messages, todos, grants, read files) lives on the server and is
 * reached through the protocol; nothing here is a copy of it. What is here is what a
 * screen needs and a log does not carry: which entries to draw, what is streaming right
 * now, and what the user is looking at. `06-frontend.md` puts the same rule the other way
 * round: "the frontend owns only its own UI state, never a copy of the session".
 *
 * `project()` derives this from the log, so the same log always produces the same view
 * (ADR-059 ②) — which is what makes a frame snapshot a test rather than a photograph.
 */

export type EntryKind = 'user' | 'assistant' | 'tool' | 'notice';

export interface UserEntry {
  readonly kind: 'user';
  /** The event's `seq`. One event, one entry, so the log's numbering is the key. */
  readonly seq: number;
  readonly text: string;
}

export interface AssistantEntry {
  readonly kind: 'assistant';
  readonly seq: number;
  readonly text: string;
  /** How many tool calls came with the text; 0 when the answer was just words. */
  readonly calls: number;
  /**
   * The thinking blocks the model produced on the way to this answer (ADR-045), as plain
   * text. Kept on the entry rather than in a side table so a replay rebuilds them with the
   * answer they belong to.
   */
  readonly reasoning: readonly string[];
  /** Blocks the provider redacted: counted, never shown, because the bytes are not ours. */
  readonly redactedThinking: number;
}

export interface TranscriptToolEntry {
  readonly kind: 'tool';
  readonly seq: number;
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly output: string;
  /** The cap that applied, in words, or `null` when nothing was dropped (ADR-048). */
  readonly truncation: string | null;
  /** Attachment paths; the bytes are not in the log (ADR-057). */
  readonly attachments: readonly string[];
  readonly path: string | null;
}

export interface NoticeEntry {
  readonly kind: 'notice';
  readonly seq: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

export type Entry = UserEntry | AssistantEntry | TranscriptToolEntry | NoticeEntry;

export interface TodoView {
  readonly content: string;
  readonly status: string;
  readonly activeForm: string;
}

export interface ApprovalView {
  readonly callId: string;
  readonly name: string;
  readonly rule: string;
  readonly reason: string | null;
  /** What the command would cost if it went wrong (ADR-095), already worded. */
  readonly warning: string | null;
  /** The event's `ts`. A clock is what turns "waiting" into the brand's nudge after 10s. */
  readonly askedAt: number;
  /** `null` while the question is open; the verdict afterwards. */
  readonly verdict: string | null;
  readonly by: string | null;
}

/** The four answers, in the order the card offers them. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'reject';

/** One implementation option from an `ExitPlan` call (ADR-125). */
export interface PlanCardOption {
  readonly title: string;
  readonly summary: string;
}

/** An open plan review: the options, until `plan.decided` lands. */
export interface PlanView {
  readonly callId: string;
  readonly plans: readonly PlanCardOption[];
  /** `null` while the question is open; 'none' or the picked plan afterwards. */
  readonly outcome: string | null;
}

/** What the highlighted plan row answers: a plan index, or `null` for "none of them". */
export type PlanAnswer = { readonly kind: 'plan'; readonly index: number } | { readonly kind: 'none' };

export const APPROVAL_CHOICES: readonly ApprovalChoice[] = ['once', 'session', 'always', 'reject'];

/** A delegated run, as the status panel and the status line need it. */
export interface AgentView {
  readonly childSessionId: string;
  readonly role: string;
  readonly description: string;
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly turns: number;
  /** The `subagent.started` timestamp; the panel shows how long it has been running. */
  readonly startedAt: number;
}

/** A tool call that has been asked for and has not finished yet. */
export interface PendingTool {
  readonly callId: string;
  readonly name: string;
}

/**
 * How a background task stands on screen (ADR-113).
 *
 * `unknown` is not a fifth state the registry reports: it is what this view says about a
 * task whose start it replayed but whose end it never saw, or whose transport closed while
 * the task was running.
 */
export type BackgroundTaskState = 'running' | 'exited' | 'stopped' | 'lost' | 'unknown';

/** One line of the catalog the model was given (ADR-116), as `/skills` shows it. */
export interface SkillView {
  readonly name: string;
  readonly layer: 'user' | 'project';
  readonly origin: 'cowcat' | 'claude';
}

export interface BackgroundTaskView {
  readonly taskId: string;
  readonly callId: string;
  readonly command: string;
  readonly startedAt: number;
  /** The log seq of the start, so a replay can be recognised after the fact. */
  readonly startedSeq: number;
  readonly state: BackgroundTaskState;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
}

/**
 * One running tool's live tail (ADR-109).
 *
 * `truncated` records that the character cap dropped earlier output, so the card can say
 * "只显示末尾输出" instead of a line count that would only describe what survived the cap —
 * a smaller number than what the command actually printed.
 */
export interface ToolTail {
  readonly text: string;
  readonly truncated: boolean;
}

/** A tool call the model asked for, before its result arrives. */
export interface ToolCallView {
  readonly name: string;
  /** The model's raw input. A renderer reads the fields it knows (`Edit`'s two strings). */
  readonly input: unknown;
}

/**
 * An attachment, and whether its bytes have arrived.
 *
 * The log holds a REFERENCE (ADR-057): `tool.finished.attachments` says an image exists and
 * how big it is, and the bytes come over the protocol (`attachment.read`) when a renderer
 * actually wants to show them. So an attachment has three states rather than two, and the
 * interface shows the difference: `loading` is "asked for it", `failed` carries the reason,
 * and only `ready` has pixels.
 */
export interface AttachmentView {
  readonly path: string;
  readonly mediaType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly pages: number | null;
  readonly status: 'loading' | 'ready' | 'failed';
  /** The bytes, when they arrived. */
  readonly bytes: Uint8Array | null;
  /** Why it failed, in the host's words. */
  readonly reason: string | null;
}

export interface TurnView {
  readonly id: string;
  readonly state: string;
  readonly reason: string | null;
}

export interface TuiView {
  readonly sessionId: string | null;
  /** Decided by the first user message that is not empty; see `detectLang`. */
  readonly lang: Lang;
  readonly langDecided: boolean;
  readonly entries: readonly Entry[];
  /**
   * The assistant text that has streamed in but is not yet a `model.message`.
   *
   * Ephemeral by construction: a delta is never persisted (ADR-059), so this is the one
   * piece of the view a log cannot reproduce — and it is cleared by the event that
   * replaces it.
   */
  readonly streaming: string;
  /**
   * Reasoning text that has streamed in for the turn in progress (ADR-098).
   *
   * Cleared by the `model.message` that replaces it, exactly like `streaming`: the final
   * blocks on the entry are the durable version, this is the live one.
   */
  readonly reasoningStream: string;
  /** How many code points of `reasoningStream` have been revealed on screen (ADR-099). */
  readonly reasoningShown: number;
  readonly turn: TurnView | null;
  readonly approval: ApprovalView | null;
  /** Which of `APPROVAL_CHOICES` is highlighted while the question is open. */
  readonly approvalCursor: number;
  /** An open plan review (ADR-125), owning the keyboard like an approval question. */
  readonly plan: PlanView | null;
  /** Which card row is highlighted: 0..plans.length, the last row being "none". */
  readonly planCursor: number;
  /** Whether the session is in plan mode (ADR-124), from `plan.mode-changed`. */
  readonly planMode: boolean;
  /** Tool calls that are in flight: the status line names them. */
  readonly pendingTools: readonly PendingTool[];
  /** Delegated runs, newest last. Finished ones stay for the session's history. */
  readonly agents: readonly AgentView[];
  /**
   * Background tasks from `tool.background.started/finished` (ADR-113), newest first.
   *
   * Durable events, so a replay rebuilds it. A task whose start was replayed but whose end
   * was not is `unknown`: this view cannot know whether the host that started it is still
   * the host it is talking to.
   */
  readonly tasks: readonly BackgroundTaskView[];
  /**
   * The skill catalog the model was given (ADR-116), in the order it appeared.
   *
   * Durable: `skills.loaded` is a log event, so `/skills` works in a resumed session without
   * asking the host to rediscover anything.
   */
  readonly skills: readonly SkillView[];
  /** The `/tasks` panel when it is open: which row is selected. */
  readonly taskPanel: { readonly index: number } | null;
  /**
   * The highest seq that arrived as replay rather than live (from `session.open.lastSeq`).
   *
   * Only used to tell "this task was already running when I connected" (unknown) from "I
   * watched it start" (running).
   */
  readonly replayedThrough: number;
  /**
   * Every tool call the log has seen, by `callId`.
   *
   * The RESULT arrives in `tool.finished`, but what the call was asked to do only exists in
   * the `model.message` that carried it — and that is where a diff comes from: `Edit`'s
   * `old_string`/`new_string` never appear in the result, so a card that wants to show the
   * change has to keep the request. Nothing else reads this.
   */
  readonly calls: Readonly<Record<string, ToolCallView>>;
  /** Call ids whose output is expanded. Interface state, not from the log. */
  readonly expanded: readonly string[];
  /** Thinking blocks are shown expanded; off by default, toggled by Ctrl-T or `/thinking`. */
  readonly thinkingExpanded: boolean;
  /**
   * The input line's current text, mirrored here so the frame can hint at `/` commands.
   *
   * It is interface state, not a log fact: `project()` spreads the view and therefore never
   * touches it.
   */
  readonly input: string;
  /**
   * Inputs sent this session, oldest first (ADR-106). Memory only: every prompt is already
   * in the log, and a second store is a second thing that can disagree with it.
   */
  readonly history: readonly string[];
  /**
   * Which history entry the composer is showing; `null` means "editing the draft".
   *
   * Kept in the view rather than in `run.ts` so recalling an entry is a pure transition and
   * the arrow-key rules can be tested without a terminal.
   */
  readonly historyIndex: number | null;
  /** The draft saved when browsing started, restored by ↓ past the newest entry. */
  readonly historyDraft: string;
  /** The model `turn.opened` reported, for the status bar (ADR-102). */
  readonly model: string | null;
  /**
   * The context window `turn.opened` reported, for the status bar's `ctx N%` (ADR-105).
   *
   * Null when the log does not say — an older kernel, or a preset that declares no window.
   * The bar then shows nothing rather than a made-up denominator.
   */
  readonly contextWindow: number | null;
  /** When the current turn opened, so the status bar can show elapsed time. */
  readonly turnStartedAt: number | null;
  /** Which `/` menu row is highlighted. */
  readonly slashIndex: number;
  /** Attachment bytes, by path: the log has the reference, this is where the pixels land. */
  readonly attachments: Readonly<Record<string, AttachmentView>>;
  readonly todosVisible: boolean;
  /** The command palette when it is open: which row is selected. */
  readonly palette: { readonly index: number } | null;
  readonly todos: readonly TodoView[];
  /**
   * The last `model.usage` the log reported (ADR-041), cache fields included.
   *
   * The status bar's `ctx` needs the same sum the kernel anchors on (`input + cacheRead +
   * cacheCreation + output`): `input` alone excludes the cached part of a prompt, which on
   * a cached request is most of it (ADR-105 ②).
   */
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
  } | null;
  /**
   * Event types this build does not know, first sighting only.
   *
   * Collected rather than ignored so "the frontend showed nothing for that" is a fact the
   * interface can state, and one line per type so a chatty new event cannot flood it.
   */
  readonly unsupported: readonly string[];
  /** The highest `seq` seen, which is what a reconnect has to resume after. */
  readonly lastSeq: number;
  /**
   * The live output tail each running tool has produced so far, keyed by call id (ADR-109).
   *
   * Interface state, not log state: the delta that fills it is ephemeral and never replayed,
   * and `tool.finished` replaces it with the durable output. Capped where it is written.
   */
  readonly toolOutput: Readonly<Record<string, ToolTail>>;
  /** Lines scrolled up from the newest row; 0 follows the tail. */
  readonly scrollOffset: number;
  /**
   * Output that arrived while the reader was scrolled up (ADR-103).
   *
   * Counting events rather than lines: "3 new results" is what a person needs to decide
   * whether to jump back; the exact row count changes with wrapping.
   */
  readonly newSinceScroll: number;
  /** The transport closed; the view stays readable. */
  readonly closed: boolean;
}

export function initialView(): TuiView {
  return {
    sessionId: null,
    lang: 'zh',
    langDecided: false,
    entries: [],
    streaming: '',
    reasoningStream: '',
    reasoningShown: 0,
    turn: null,
    approval: null,
    approvalCursor: 0,
    plan: null,
    planCursor: 0,
    planMode: false,
    pendingTools: [],
    agents: [],
    tasks: [],
    skills: [],
    taskPanel: null,
    replayedThrough: 0,
    calls: {},
    expanded: [],
    thinkingExpanded: false,
    input: '',
    history: [],
    historyIndex: null,
    historyDraft: '',
    model: null,
    contextWindow: null,
    turnStartedAt: null,
    slashIndex: 0,
    attachments: {},
    todosVisible: true,
    palette: null,
    todos: [],
    usage: null,
    unsupported: [],
    lastSeq: 0,
    toolOutput: {},
    scrollOffset: 0,
    newSinceScroll: 0,
    closed: false,
  };
}

// ── interface state ─────────────────────────────────────────────────────────────
//
// Kept beside the derived view because they are the same kind of thing to a renderer (fields
// on the view) but a different kind of thing to `project()`: these are the user's, not the
// log's, and `project` leaves them alone by construction — it spreads the view it is given.

export function toggleExpanded(view: TuiView, callId: string): TuiView {
  const expanded = view.expanded.includes(callId)
    ? view.expanded.filter((id) => id !== callId)
    : [...view.expanded, callId];
  return { ...view, expanded };
}

export function toggleThinking(view: TuiView): TuiView {
  return { ...view, thinkingExpanded: !view.thinkingExpanded };
}

export function withInput(view: TuiView, input: string): TuiView {
  if (view.input === input) return view;
  // A different query means a different list; keeping the old highlight would point at a
  // row that may no longer exist.
  return { ...view, input, slashIndex: 0 };
}

export function moveSlash(view: TuiView, delta: number, count: number): TuiView {
  if (count === 0) return view;
  const next = (view.slashIndex + delta + count) % count;
  return next === view.slashIndex ? view : { ...view, slashIndex: next };
}

/** Open the `/tasks` panel (ADR-113); nothing to show means nothing opens. */
export function openTaskPanel(view: TuiView): TuiView {
  if (view.tasks.length === 0) return view;
  return { ...view, taskPanel: { index: 0 } };
}

export function closeTaskPanel(view: TuiView): TuiView {
  return view.taskPanel === null ? view : { ...view, taskPanel: null };
}

/** Wrap-around like the other lists: a last row is one keystroke from the first. */
export function moveTaskPanel(view: TuiView, delta: number): TuiView {
  const panel = view.taskPanel;
  if (panel === null || view.tasks.length === 0) return view;
  const next = (panel.index + delta + view.tasks.length) % view.tasks.length;
  return next === panel.index ? view : { ...view, taskPanel: { index: next } };
}

/** The task under the panel's cursor, or null when the panel is closed. */
export function selectedTask(view: TuiView): BackgroundTaskView | null {
  const panel = view.taskPanel;
  if (panel === null) return null;
  return view.tasks[panel.index] ?? null;
}

/**
 * After `session.open` returns, the events up to `lastSeq` were replay, not something this
 * view watched happen. A start among them whose end never arrived is `unknown`: the host
 * that knew about it may not be the host we are talking to (ADR-113).
 */
export function markReplayedTasks(view: TuiView, lastSeq: number): TuiView {
  return {
    ...view,
    replayedThrough: lastSeq,
    tasks: view.tasks.map((task) =>
      task.state === 'running' && task.startedSeq <= lastSeq ? { ...task, state: 'unknown' as const } : task,
    ),
  };
}

/** Positive `delta` scrolls up (older lines). Reaching 0 resumes following new output. */
export function withScroll(view: TuiView, delta: number): TuiView {
  const next = Math.max(0, view.scrollOffset + delta);
  if (next === view.scrollOffset) return view;
  return { ...view, scrollOffset: next, ...(next === 0 ? { newSinceScroll: 0 } : {}) };
}

/** One more piece of output arrived while the reader was scrolled up. */
export function noteBelow(view: TuiView): TuiView {
  return view.scrollOffset === 0 ? view : { ...view, newSinceScroll: view.newSinceScroll + 1 };
}

/**
 * Reveal more of the buffered reasoning (ADR-099).
 *
 * Providers hand over reasoning in chunks of arbitrary size, so "as it arrives" is
 * chunky by nature. Revealing a few code points per tick is presentation only: the
 * buffer is what was received, this is how much of it has been drawn.
 */
export function advanceReasoning(view: TuiView, step: number): TuiView {
  const total = Array.from(view.reasoningStream).length;
  if (view.reasoningShown >= total) return view;
  return { ...view, reasoningShown: Math.min(total, view.reasoningShown + Math.max(1, step)) };
}

/** The part of the reasoning that is currently visible. */
export function revealedReasoning(view: TuiView): string {
  return Array.from(view.reasoningStream).slice(0, view.reasoningShown).join('');
}

export function resetScroll(view: TuiView): TuiView {
  return view.scrollOffset === 0 && view.newSinceScroll === 0
    ? view
    : { ...view, scrollOffset: 0, newSinceScroll: 0 };
}

/** How many prompts the history keeps; the log is the unbounded record (ADR-106). */
const HISTORY_LIMIT = 100;

/**
 * Record what was just sent (ADR-106).
 *
 * Consecutive duplicates are dropped: pressing ↑ twice after two identical prompts should be
 * one prompt, not two. Sending also ends the browsing session, so the next ↑ starts from the
 * newest entry instead of resurrecting the old position.
 */
export function rememberInput(view: TuiView, text: string): TuiView {
  const idle: TuiView = { ...view, historyIndex: null, historyDraft: '' };
  if (text === '' || view.history.at(-1) === text) return idle;
  return { ...idle, history: [...view.history, text].slice(-HISTORY_LIMIT) };
}

/**
 * Move through the input history (ADR-106).
 *
 * `older` saves the draft on the way in and clamps at the oldest entry; `newer` walks back
 * and, past the newest entry, restores the draft. Returning the same view means "there is
 * nothing to recall", which the caller reads as "this arrow still belongs to the cursor".
 */
export function withHistory(view: TuiView, direction: 'older' | 'newer'): TuiView {
  const { history } = view;
  if (history.length === 0) return view;
  if (direction === 'older') {
    if (view.historyIndex === null) {
      const index = history.length - 1;
      return { ...view, historyIndex: index, historyDraft: view.input, input: history[index] ?? view.input };
    }
    if (view.historyIndex === 0) return view;
    const index = view.historyIndex - 1;
    return { ...view, historyIndex: index, input: history[index] ?? view.input };
  }
  if (view.historyIndex === null) return view;
  if (view.historyIndex < history.length - 1) {
    const index = view.historyIndex + 1;
    return { ...view, historyIndex: index, input: history[index] ?? view.input };
  }
  return { ...view, historyIndex: null, input: view.historyDraft, historyDraft: '' };
}

/** The answer the highlighted row stands for. */
export function approvalChoiceAt(view: TuiView): ApprovalChoice {
  return APPROVAL_CHOICES[view.approvalCursor] ?? 'once';
}

/** Move the highlight, clamped: a list of four is not a carousel. */
export function moveApprovalCursor(view: TuiView, delta: number): TuiView {
  const next = Math.max(0, Math.min(APPROVAL_CHOICES.length - 1, view.approvalCursor + delta));
  return next === view.approvalCursor ? view : { ...view, approvalCursor: next };
}

/** The plan card's rows: one per plan, plus the trailing "none of them". */
export function planRowCount(view: TuiView): number {
  return (view.plan?.plans.length ?? 0) + 1;
}

export function movePlanCursor(view: TuiView, delta: number): TuiView {
  const next = Math.max(0, Math.min(planRowCount(view) - 1, view.planCursor + delta));
  return next === view.planCursor ? view : { ...view, planCursor: next };
}

/** What the highlighted plan row answers. */
export function planAnswerAt(view: TuiView): PlanAnswer {
  const plan = view.plan;
  if (plan === null) return { kind: 'none' };
  return view.planCursor < plan.plans.length ? { kind: 'plan', index: view.planCursor } : { kind: 'none' };
}

/** The answers that are still running, for the panel. */
export function runningAgents(view: TuiView): readonly AgentView[] {
  return view.agents.filter((agent) => agent.state === 'running');
}

export function toggleTodos(view: TuiView): TuiView {
  return { ...view, todosVisible: !view.todosVisible };
}

/** Record an attachment (an image/PDF reference) and its state, by path. */
export function withAttachment(view: TuiView, attachment: AttachmentView): TuiView {
  return { ...view, attachments: { ...view.attachments, [attachment.path]: attachment } };
}

/** Everything still waiting for bytes, for the loop that fetches them. */
export function pendingAttachments(view: TuiView): readonly AttachmentView[] {
  return Object.values(view.attachments).filter((attachment) => attachment.status === 'loading');
}

export function openPalette(view: TuiView): TuiView {
  return { ...view, palette: { index: 0 } };
}

export function closePalette(view: TuiView): TuiView {
  return { ...view, palette: null };
}

/** Move the palette selection, wrapping at both ends (`count` rows). */
export function movePalette(view: TuiView, delta: number, count: number): TuiView {
  if (view.palette === null || count === 0) return view;
  const index = (view.palette.index + delta + count) % count;
  return { ...view, palette: { index } };
}

/** The language of any user text, decided once and then left alone. */
export function withLangFrom(view: TuiView, input: string): TuiView {
  if (view.langDecided || input.trim() === '') return view;
  return { ...view, lang: detectLang(input), langDecided: true };
}
