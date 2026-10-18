import type { KernelEvent } from './events.js';
import type { Message } from './messages.js';
import type { TodoItem } from '../ports/index.js';
import { canTransition, type TurnState } from './turn.js';

export interface TurnView {
  readonly id: string;
  readonly state: TurnState;
}

export interface SessionState {
  readonly sessionId: string;
  readonly lastSeq: number;
  readonly turn: TurnView | null;
  readonly messages: readonly Message[];
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
  return { sessionId, lastSeq: 0, turn: null, messages: [], grants: [], readFiles: [], todos: [] };
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
    case 'model.message':
      return {
        ...base,
        messages: [
          ...state.messages,
          { role: 'assistant', text: event.text, toolCalls: event.toolCalls, reasoning: event.reasoning },
        ],
      };
    case 'model.usage':
      // Nothing to derive: what a call cost does not change the conversation, and
      // putting it into the state would make every replay compare numbers that no
      // later decision reads. The event is in the log for whoever reports or audits
      // cost (ADR-041).
      return base;
    case 'tool.finished': {
      const readFiles = registerRead(state.readFiles, event);
      return {
        ...base,
        messages: [...state.messages, { role: 'tool', callId: event.callId, ok: event.ok, output: event.output }],
        // Same array when nothing changed: a replay of many tool calls should not
        // allocate a new list for each one that was not a read.
        ...(readFiles === state.readFiles ? {} : { readFiles }),
      };
    }
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
      return event.verdict === 'always' ? { ...base, grants: [...state.grants, event.key] } : base;
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
