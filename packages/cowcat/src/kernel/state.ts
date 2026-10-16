import type { KernelEvent } from './events.js';
import type { Message } from './messages.js';
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
}

export function initialState(sessionId: string): SessionState {
  return { sessionId, lastSeq: 0, turn: null, messages: [] };
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
        messages: [...state.messages, { role: 'assistant', text: event.text, toolCalls: event.toolCalls }],
      };
    case 'tool.finished':
      return {
        ...base,
        messages: [...state.messages, { role: 'tool', callId: event.callId, ok: event.ok, output: event.output }],
      };
    case 'policy.decided':
      return base;
  }
}

export function replay(sessionId: string, events: readonly KernelEvent[]): SessionState {
  return events.reduce(reduce, initialState(sessionId));
}
