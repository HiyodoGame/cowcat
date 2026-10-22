import type { KernelEvent } from './events.js';
import type { Message } from './messages.js';
import type { TodoItem } from '../ports/index.js';
import { canTransition, type TurnState } from './turn.js';

export interface TurnView {
  readonly id: string;
  readonly state: TurnState;
}

/**
 * A provider's usage count and the log position it describes (ADR-070).
 *
 * `anchorSeq` is the seq of the assistant message that request produced. Everything at
 * or below it was part of that count; everything after it is estimated locally until the
 * next report.
 */
export interface UsageAnchor {
  readonly tokens: number;
  readonly anchorSeq: number;
}

export interface SessionState {
  readonly sessionId: string;
  readonly lastSeq: number;
  readonly turn: TurnView | null;
  readonly messages: readonly Message[];
  /**
   * The seq of the event each message came from, positionally aligned with `messages`
   * (ADR-071).
   *
   * Kept beside the messages rather than inside `Message` so the adapters keep seeing a
   * message and nothing else. It exists because "which messages are still sent" is a
   * question about the **log**, not about the text: a compaction shadows a range of
   * seqs, and only the seq knows where that range ends.
   */
  readonly messageSeqs: readonly number[];
  /**
   * What the provider reported for its last request, and where in the log that request
   * ended (ADR-070). `null` until the model has answered once, and after every
   * compaction — the messages the count described are no longer the ones being sent.
   *
   * Folded rather than held beside the log, for the same reason as `todos`: a reopened
   * session should not have to re-ask the provider to know how full it is.
   */
  readonly lastUsage: UsageAnchor | null;
  /**
   * Whether a compaction has started and not finished (ADR-072).
   *
   * Derived from the log so a reopened session knows an attempt was interrupted. It is
   * a guard, not a blocker: a second `started` is accepted (recovery), and only the
   * `finished` that follows the last attempt clears it.
   */
  readonly compactionOpen: boolean;
  /**
   * The seq of the `instructions.loaded` message currently in `messages`, or null when
   * there is none (ADR-078).
   *
   * This is the whole "should I inject?" question: a compaction shadows the message and
   * resets this to null, so the next turn re-injects — the rule lives in the fold rather
   * than in a caller that has to remember to re-run.
   */
  readonly instructionsSeq: number | null;
  /** How many times instructions have been injected, which decides `start` vs `refresh`. */
  readonly instructionsCount: number;
  /**
   * The seq of the `skills.loaded` message currently in `messages`, or null when there is
   * none (ADR-116 ④).
   *
   * Same rule as `instructionsSeq`: a compaction shadows the catalog message and resets
   * this, so the next turn re-injects it rather than leaving the model with a list it can
   * no longer see.
   */
  readonly skillsSeq: number | null;
  /** How many times the catalog was injected, which decides `start` vs `refresh`. */
  readonly skillsCount: number;
  /**
   * Actions answered `always`, for the rest of this session (ADR-031 decision 3).
   *
   * Derived from the log rather than held beside it, which is what makes the promise
   * "replaying the log reproduces the live session" true for a grant as well: a
   * reopened session gets its grants back because it gets its events back. Nothing
   * here outlives the session — permanent rules need a way to revoke them first
   * (ADR-026), and that does not exist yet.
   */
  readonly grants: readonly string[];
  /**
   * Canonical paths this session has read successfully (ADR-049), in the order they
   * were first read.
   *
   * Derived from `tool.finished` rather than held beside the log, so "read before
   * write" survives a reopened session: the gate is a fact about the log, not about
   * this process's memory (the legacy `ctx.readSet` was memory and silently forgot).
   */
  readonly readFiles: readonly string[];
  /**
   * The session's todo list (ADR-054), replaced wholesale by each `todo.updated`.
   *
   * Derived from the log rather than held by the tool or by a file beside the session:
   * a reopened session gets its list back because it gets its events back, the same
   * promise `grants` and `readFiles` keep.
   */
  readonly todos: readonly TodoItem[];
}

export function initialState(sessionId: string): SessionState {
  return {
    sessionId,
    lastSeq: 0,
    turn: null,
    messages: [],
    messageSeqs: [],
    lastUsage: null,
    compactionOpen: false,
    instructionsSeq: null,
    instructionsCount: 0,
    skillsSeq: null,
    skillsCount: 0,
    grants: [],
    readFiles: [],
    todos: [],
  };
}

// Pure and total over valid logs. A log that contradicts itself (a transition
// from a state the turn is not in) throws: that is corruption, not a race.
export function reduce(state: SessionState, event: KernelEvent): SessionState {
  const base = { ...state, lastSeq: event.seq };
  switch (event.type) {
    case 'session.opened': {
      // The header is the log's first fact by construction. Anything else means
      // the file was appended to without one (ADR-012).
      if (state.lastSeq !== 0) throw new Error('corrupt log: session.opened is not the first event');
      return base;
    }
    case 'turn.opened': {
      if (event.turnId === null) throw new Error('turn.opened without turnId');
      return {
        ...base,
        turn: { id: event.turnId, state: 'idle' },
        messages: [...state.messages, { role: 'user', text: event.input }],
        messageSeqs: [...state.messageSeqs, event.seq],
      };
    }
    case 'turn.transitioned': {
      if (state.turn === null || state.turn.id !== event.turnId) {
        throw new Error(`transition for a turn that is not open: ${event.turnId ?? 'null'}`);
      }
      if (state.turn.state !== event.from || !canTransition(event.from, event.to)) {
        throw new Error(`corrupt log: ${event.from} -> ${event.to} while turn is ${state.turn.state}`);
      }
      return { ...base, turn: { id: state.turn.id, state: event.to } };
    }
    case 'turn.noted':
      // A fact about the turn, not a change to it: it is in the log so a replay can show
      // it, and folding it into state would make it something the kernel has to reason
      // about (which is exactly what a note is not).
      return base;
    case 'model.message':
      return {
        ...base,
        messages: [
          ...state.messages,
          { role: 'assistant', text: event.text, toolCalls: event.toolCalls, reasoning: event.reasoning },
        ],
        messageSeqs: [...state.messageSeqs, event.seq],
      };
    case 'model.usage':
      // The only thing folded from usage is the anchor (ADR-070): how full the next
      // request already is. What the call *cost* stays in the log for whoever reports or
      // audits it (ADR-041); this is a different question, asked once per turn.
      return {
        ...base,
        lastUsage: {
          tokens: event.usage.input + event.usage.cacheRead + event.usage.cacheCreation + event.usage.output,
          // The request ended at the model.message that this usage describes. Everything
          // after it (the tool results this turn produced) is added by the estimator.
          anchorSeq: state.lastSeq,
        },
      };
    case 'context.compacted': {
      // Keep the tail, replace the head (ADR-071). `throughSeq` is the watermark: the
      // summary itself takes the compaction event's own seq, so a later compaction can
      // shadow it the same way.
      const kept: Message[] = [];
      const keptSeqs: number[] = [];
      for (const [index, message] of state.messages.entries()) {
        const seq = state.messageSeqs[index];
        if (seq !== undefined) {
          if (seq > event.throughSeq) {
            kept.push(message);
            keptSeqs.push(seq);
          }
        }
      }
      return {
        ...base,
        messages: [{ role: 'user', text: event.summary }, ...kept],
        messageSeqs: [event.seq, ...keptSeqs],
        // The anchor counted messages that are no longer sent; keeping it would
        // over-estimate this session forever. The next request re-establishes it.
        lastUsage: null,
        // The instructions were the first message, so the summary swallowed them
        // (ADR-078 ①). Clearing this makes the next turn inject them again.
        ...(state.instructionsSeq !== null && state.instructionsSeq <= event.throughSeq
          ? { instructionsSeq: null }
          : {}),
        // The catalog is injected after the instructions for the same reason, and follows
        // the same rule: summarized away means re-inject (ADR-116 ④).
        ...(state.skillsSeq !== null && state.skillsSeq <= event.throughSeq ? { skillsSeq: null } : {}),
      };
    }
    case 'instructions.loaded':
      // A message-producing event like `turn.opened`: what the model was told about the
      // repository is part of the conversation, so a replay reproduces it without
      // touching the filesystem (ADR-078).
      return {
        ...base,
        messages: [...state.messages, { role: 'user', text: event.text }],
        messageSeqs: [...state.messageSeqs, event.seq],
        instructionsSeq: event.seq,
        instructionsCount: state.instructionsCount + 1,
      };
    case 'skills.loaded':
      // Same shape as `instructions.loaded` (ADR-116 ⑥): the catalog is a fact about what
      // the model was told, so it is a message, not a side table.
      return {
        ...base,
        messages: [...state.messages, { role: 'user', text: event.text }],
        messageSeqs: [...state.messageSeqs, event.seq],
        skillsSeq: event.seq,
        skillsCount: state.skillsCount + 1,
      };
    case 'context.compaction.started':
      return { ...base, compactionOpen: true };
    case 'context.compaction.finished':
      return { ...base, compactionOpen: false };
    case 'tool.finished': {
      const readFiles = registerRead(state.readFiles, event);
      return {
        ...base,
        messages: [
          ...state.messages,
          {
            role: 'tool',
            callId: event.callId,
            ok: event.ok,
            output: event.output,
            // `null` (the tool reported nothing) and `[]` (it reported "no attachments")
            // become the same thing here on purpose: a message says what it carries, and
            // "carries none" is one statement. The distinction stays in the log, where
            // the tool's own words are what is being recorded.
            attachments: event.attachments ?? [],
          },
        ],
        messageSeqs: [...state.messageSeqs, event.seq],
        // Same array when nothing changed: a replay of many tool calls should not
        // allocate a new list for each one that was not a read.
        ...(readFiles === state.readFiles ? {} : { readFiles }),
      };
    }
    case 'tool.repeat-detected':
      // A message-producing event like `instructions.loaded` (ADR-120): the reminder is
      // part of the conversation, so replay reproduces it from the log alone.
      return {
        ...base,
        messages: [...state.messages, { role: 'user', text: event.text }],
        messageSeqs: [...state.messageSeqs, event.seq],
      };
    case 'hooks.context-added':
      // Same shape as `instructions.loaded` (ADR-122 ④): hook context is part of the
      // conversation, so replay reproduces it without re-running the hook.
      return {
        ...base,
        messages: [...state.messages, { role: 'user', text: event.text }],
        messageSeqs: [...state.messageSeqs, event.seq],
      };
    case 'subagent.started':
    case 'subagent.finished':
      // Delegation is a fact about the parent log, not about its messages: what the model
      // sees is the `tool.finished` that follows. Nothing is derived, so replay ignores
      // these two — the same shape `policy.decided` has, for the same reason.
      return base;
    case 'tool.background.started':
    case 'tool.background.finished':
      // The registry owns the task; the log only records that it existed and how it ended.
      // A frontend derives its panel from these events, never from kernel state.
      return base;
    case 'policy.decided':
      return base;
    case 'todo.updated':
      // Full replacement, and no merging: the model sent the whole list (ADR-054).
      return { ...base, todos: event.todos };
    case 'approval.requested':
      // Nothing to derive: the question is recorded, but "being asked" is not a fact
      // about the session's policy. The answer is, and it arrives next.
      return base;
    case 'approval.answered':
      // Both standing answers are keys. `always` stores the exact action; `session`
      // stores the tool-level key it was emitted with (ADR-094), so a reopened session
      // gets the narrower grant back and not something wider.
      return event.verdict === 'always' || event.verdict === 'session'
        ? { ...base, grants: [...state.grants, event.key] }
        : base;
  }
}

// The tool name is the only thing `reduce` can select on: the tool's spec is not part
// of the log and the kernel does not hold a registry while replaying (ADR-049). T2 must
// therefore name the read tool exactly this, and the constant is the one place to change
// if that ever stops being true.
const READ_TOOL_NAME = 'Read';

// Registers a successful read. Returns the SAME array when nothing changes, which keeps
// a replay of mostly-writes from copying the list on every event.
function registerRead(
  readFiles: readonly string[],
  event: Extract<KernelEvent, { type: 'tool.finished' }>,
): readonly string[] {
  if (!event.ok || event.name !== READ_TOOL_NAME || event.path === null) return readFiles;
  if (readFiles.includes(event.path)) return readFiles;
  return [...readFiles, event.path];
}

export function replay(sessionId: string, events: readonly KernelEvent[]): SessionState {
  return events.reduce(reduce, initialState(sessionId));
}
