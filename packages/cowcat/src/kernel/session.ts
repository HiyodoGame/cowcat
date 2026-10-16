import type { Clock, EventStore, IdSource } from '../ports/index.js';
import type { EventInput, KernelEvent, SessionUpdate } from './events.js';
import { initialState, reduce, replay, type SessionState } from './state.js';
import { canTransition, IllegalTransitionError, isTerminal, type TurnState } from './turn.js';

export interface SessionDeps {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly ids: IdSource;
}

export class Session {
  readonly #deps: SessionDeps;
  #state: SessionState;
  readonly #listeners = new Set<(update: SessionUpdate) => void>();

  private constructor(deps: SessionDeps, state: SessionState) {
    this.#deps = deps;
    this.#state = state;
  }

  static async open(deps: SessionDeps, sessionId: string): Promise<Session> {
    const events = await deps.store.readAll(sessionId);
    return new Session(deps, replay(sessionId, events));
  }

  static create(deps: SessionDeps, sessionId: string): Session {
    return new Session(deps, initialState(sessionId));
  }

  get state(): SessionState {
    return this.#state;
  }

  get turnId(): string | null {
    return this.#state.turn?.id ?? null;
  }

  subscribe(listener: (update: SessionUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Persist first, then apply, then notify. A listener never sees a fact the
  // log does not have, so a crash between steps loses at most the live view.
  async emit(input: EventInput): Promise<KernelEvent> {
    const event = {
      ...input,
      seq: this.#state.lastSeq + 1,
      ts: this.#deps.clock.now(),
      sessionId: this.#state.sessionId,
    } as KernelEvent;
    await this.#deps.store.append(event);
    this.#state = reduce(this.#state, event);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  streamDelta(text: string): void {
    const turnId = this.turnId;
    if (turnId === null) throw new Error('streamDelta outside a turn');
    for (const listener of this.#listeners) listener({ type: 'model.delta', turnId, text });
  }

  async openTurn(input: string): Promise<string> {
    const current = this.#state.turn?.state;
    if (current !== undefined && !isTerminal(current)) throw new Error('a turn is already open');
    const turnId = this.#deps.ids.next('turn');
    await this.emit({ type: 'turn.opened', turnId, input });
    await this.transition('requesting');
    return turnId;
  }

  async transition(to: TurnState, reason: string | null = null): Promise<void> {
    const turn = this.#state.turn;
    if (turn === null) throw new Error('no open turn');
    if (!canTransition(turn.state, to)) throw new IllegalTransitionError(turn.state, to);
    await this.emit({ type: 'turn.transitioned', turnId: turn.id, from: turn.state, to, reason });
  }
}
