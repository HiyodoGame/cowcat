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
  /** The event's `ts`. A clock is what turns "waiting" into the brand's nudge after 10s. */
  readonly askedAt: number;
  /** `null` while the question is open; the verdict afterwards. */
  readonly verdict: string | null;
  readonly by: string | null;
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
  readonly turn: TurnView | null;
  readonly approval: ApprovalView | null;
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
  /** Attachment bytes, by path: the log has the reference, this is where the pixels land. */
  readonly attachments: Readonly<Record<string, AttachmentView>>;
  readonly todosVisible: boolean;
  /** The command palette when it is open: which row is selected. */
  readonly palette: { readonly index: number } | null;
  readonly todos: readonly TodoView[];
  readonly usage: { readonly input: number; readonly output: number } | null;
  /**
   * Event types this build does not know, first sighting only.
   *
   * Collected rather than ignored so "the frontend showed nothing for that" is a fact the
   * interface can state, and one line per type so a chatty new event cannot flood it.
   */
  readonly unsupported: readonly string[];
  /** The highest `seq` seen, which is what a reconnect has to resume after. */
  readonly lastSeq: number;
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
    turn: null,
    approval: null,
    calls: {},
    expanded: [],
    attachments: {},
    todosVisible: true,
    palette: null,
    todos: [],
    usage: null,
    unsupported: [],
    lastSeq: 0,
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
