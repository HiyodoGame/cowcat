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
  /** `null` while the question is open; the verdict afterwards. */
  readonly verdict: string | null;
  readonly by: string | null;
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
    todos: [],
    usage: null,
    unsupported: [],
    lastSeq: 0,
    closed: false,
  };
}

/** The language of any user text, decided once and then left alone. */
export function withLangFrom(view: TuiView, input: string): TuiView {
  if (view.langDecided || input.trim() === '') return view;
  return { ...view, lang: detectLang(input), langDecided: true };
}
