import type { Clock, EventStore, IdSource } from '../ports/index.js';
import type { EventInput, KernelEvent, SessionUpdate } from './events.js';
import { assertSupportedSchemaVersion, SCHEMA_VERSION } from './schema-version.js';
import { initialState, reduce, replay, type SessionState } from './state.js';
import { canTransition, IllegalTransitionError, isTerminal, type TurnState } from './turn.js';

export interface SessionDeps {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  // Supplied by the composition root (from package.json). The kernel cannot read
  // the filesystem, so its own version has to be handed to it — see ADR-012.
  readonly cowcatVersion: string;
}

export class Session {
  readonly #deps: SessionDeps;
  #state: SessionState;
  readonly #listeners = new Set<(update: SessionUpdate) => void>();

  private constructor(deps: SessionDeps, state: SessionState) {
    this.#deps = deps;
    this.#state = state;
  }

  // An empty log means the session does not exist, not that it has no history:
  // only create may start one, so that a header is always the first line (ADR-012).
  static async open(deps: SessionDeps, sessionId: string): Promise<Session> {
    const events = await deps.store.readAll(sessionId);
    const header = events[0];
    if (header === undefined) throw new Error(`no such session: ${sessionId}`);
    if (header.type !== 'session.opened') {
      throw new Error(`session ${sessionId} has no session header; the log starts with ${header.type}`);
    }
    assertSupportedSchemaVersion(header.schemaVersion, sessionId);
    return new Session(deps, replay(sessionId, events));
  }

  static async create(deps: SessionDeps, sessionId: string): Promise<Session> {
    // Refusing an existing log keeps create the only writer of the header: a
    // second create would emit a second `seq = 1` and the log would stop
    // replaying. Catching it here is a write-time failure, not a reopen-time one.
    const existing = await deps.store.readAll(sessionId);
    if (existing.length > 0) throw new Error(`session already exists: ${sessionId}`);
    const session = new Session(deps, initialState(sessionId));
    await session.emit({
      type: 'session.opened',
      turnId: null,
      schemaVersion: SCHEMA_VERSION,
      cowcatVersion: deps.cowcatVersion,
    });
    return session;
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
