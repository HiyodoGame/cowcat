export type TurnState =
  | 'idle'
  | 'requesting'
  | 'streaming'
  | 'awaiting_tools'
  | 'awaiting_approval'
  | 'finishing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type TerminalTurnState = 'completed' | 'cancelled' | 'failed';

const TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  idle: ['requesting'],
  requesting: ['streaming', 'failed', 'cancelled'],
  streaming: ['finishing', 'awaiting_tools', 'failed', 'cancelled'],
  awaiting_tools: ['awaiting_approval', 'requesting', 'failed', 'cancelled'],
  awaiting_approval: ['awaiting_tools', 'failed', 'cancelled'],
  finishing: ['completed', 'failed', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};

export function isTerminal(state: TurnState): state is TerminalTurnState {
  return state === 'completed' || state === 'cancelled' || state === 'failed';
}

export function canTransition(from: TurnState, to: TurnState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TurnState,
    readonly to: TurnState,
  ) {
    super(`illegal turn transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}
