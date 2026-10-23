import type { BackgroundEndState, Clock, CronCreatedRef, EventStore, ExecutionFacts, IdSource, LockPort, SessionLock, SessionSnapshot, SessionShell, SnapshotPort, TerminationReason, ToolOutputStream } from '../ports/index.js';
import type { EventInput, KernelEvent, SessionParent, SessionUpdate } from './events.js';
import { assertSupportedSchemaVersion, isSupportedSchemaVersion, SCHEMA_VERSION } from './schema-version.js';
import type { PriceTable } from './preset.js';
import { initialState, reduce, replay, type SessionState } from './state.js';
import { canTransition, IllegalTransitionError, isTerminal, type TurnState } from './turn.js';

export interface SessionDeps {
  readonly store: EventStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  // One writer per session. Held for the whole life of the Session and released by
  // close(); a lock scoped to a single append could not protect the
  // replay → read seq → append window (ADR-010).
  readonly lock: LockPort;
  // Replay acceleration only: a snapshot that cannot be trusted is ignored, and the
  // log alone decides the state (ADR-013).
  readonly snapshots: SnapshotPort;
  // Supplied by the composition root (from package.json). The kernel cannot read
  // the filesystem, so its own version has to be handed to it — see ADR-012.
  readonly cowcatVersion: string;
  // Which shell this session's commands run through, resolved by PlatformPort before
  // create() and recorded in the header for the same reason: a log that says "these
  // commands ran" without saying in what shell is not reproducible (ADR-012).
  readonly shell: SessionShell;
}

/** What a `create` may attach that no later append can add (ADR-079 ③). */
export interface SessionCreateOptions {
  readonly parent?: SessionParent;
  /** Creation directory and initial preset model, recorded on the header (ADR-126). */
  readonly cwd?: string;
  readonly model?: string;
}

export class Session {
  readonly #deps: SessionDeps;
  readonly #lock: SessionLock;
  #state: SessionState;
  #closed = false;
  readonly #listeners = new Set<(update: SessionUpdate) => void>();

  private constructor(deps: SessionDeps, state: SessionState, lock: SessionLock) {
    this.#deps = deps;
    this.#state = state;
    this.#lock = lock;
  }

  // An empty log means the session does not exist, not that it has no history:
  // only create may start one, so that a header is always the first line (ADR-012).
  //
  // The lock is claimed before the log is read. Reading first would leave a window
  // in which another writer appends, and the state we replayed would be stale by
  // the time we emitted against it (ADR-010).
  static async open(deps: SessionDeps, sessionId: string): Promise<Session> {
    const lock = await deps.lock.acquire(sessionId);
    try {
      const events = await deps.store.readAll(sessionId);
      const header = events[0];
      if (header === undefined) throw new Error(`no such session: ${sessionId}`);
      if (header.type !== 'session.opened') {
        throw new Error(`session ${sessionId} has no session header; the log starts with ${header.type}`);
      }
      assertSupportedSchemaVersion(header.schemaVersion, sessionId);
      const snapshot = await deps.snapshots.load(sessionId);
      return new Session(deps, stateFrom(sessionId, events, snapshot), lock);
    } catch (error) {
      // A failed open must not keep the lock: our own pid is alive, so this very
      // process would be refused on the next attempt.
      await lock.release();
      throw error;
    }
  }

  static async create(deps: SessionDeps, sessionId: string, options: SessionCreateOptions = {}): Promise<Session> {
    const lock = await deps.lock.acquire(sessionId);
    try {
      // Refusing an existing log keeps create the only writer of the header: a
      // second create would emit a second `seq = 1` and the log would stop
      // replaying. Catching it here is a write-time failure, not a reopen-time one.
      const existing = await deps.store.readAll(sessionId);
      if (existing.length > 0) throw new Error(`session already exists: ${sessionId}`);
      const session = new Session(deps, initialState(sessionId), lock);
      await session.emit({
        type: 'session.opened',
        turnId: null,
        schemaVersion: SCHEMA_VERSION,
        cowcatVersion: deps.cowcatVersion,
        shell: deps.shell,
        ...(options.parent === undefined ? {} : { parent: options.parent }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.model === undefined ? {} : { model: options.model }),
      });
      return session;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  // Releases the single-writer claim. Idempotent: the port tolerates releasing a
  // lock that is already gone.
  async close(): Promise<void> {
    this.#closed = true;
    await this.#lock.release();
  }

  // Explicit by design: when to snapshot depends on how long sessions really get, and
  // P1 has no data for that, so a threshold now would be a guess. Not blocked after
  // close(): it writes derived data, not a log fact (ADR-013).
  async saveSnapshot(): Promise<void> {
    await this.#deps.snapshots.save(this.#state.sessionId, {
      schemaVersion: SCHEMA_VERSION,
      lastSeq: this.#state.lastSeq,
      state: this.#state,
    });
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

  /**
   * Write serialization (ADR-111).
   *
   * `seq` is derived from the current state, so two emitters that interleave their awaits
   * would derive the same number. Everything used to be one async chain inside `runTurn`;
   * background tasks now end on their own schedule and write from the host, so the guarantee
   * has to live here instead of in the caller's discipline.
   */
  #writeLock: Promise<unknown> = Promise.resolve();

  // Persist first, then apply, then notify. A listener never sees a fact the
  // log does not have, so a crash between steps loses at most the live view.
  async emit(input: EventInput): Promise<KernelEvent> {
    const write = async (): Promise<KernelEvent> => {
      // After close() the lock is gone, so writing would break the invariant the lock
      // exists to protect. Enforced here rather than left to callers, for the same
      // reason the lock lives in Session at all (ADR-010).
      if (this.#closed) throw new Error('session is closed');
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
    };
    // `then(write, write)`: a failed write must not poison the queue for everything after it.
    const result = this.#writeLock.then(write, write);
    this.#writeLock = result.catch(() => undefined);
    return result;
  }

  streamDelta(text: string): void {
    const turnId = this.turnId;
    if (turnId === null) throw new Error('streamDelta outside a turn');
    for (const listener of this.#listeners) listener({ type: 'model.delta', turnId, text });
  }

  reasoningDelta(text: string): void {
    const turnId = this.turnId;
    if (turnId === null) throw new Error('reasoningDelta outside a turn');
    for (const listener of this.#listeners) listener({ type: 'reasoning.delta', turnId, text });
  }

  /**
   * A live fragment of a tool's output (ADR-108).
   *
   * Ephemeral like the two above: `tool.finished.output` is the fact, this is the view.
   * `callId` travels with it because a turn can have several tools running and the card
   * that asked for this output is keyed by it.
   */
  toolOutput(callId: string, stream: ToolOutputStream, text: string): void {
    const turnId = this.turnId;
    if (turnId === null) throw new Error('toolOutput outside a turn');
    for (const listener of this.#listeners) listener({ type: 'tool.output.delta', turnId, callId, stream, text });
  }

  /** A background task was started by this turn (ADR-111). */
  async backgroundStarted(callId: string, taskId: string, command: string): Promise<void> {
    const turnId = this.turnId;
    if (turnId === null) throw new Error('backgroundStarted outside a turn');
    await this.emit({ type: 'tool.background.started', turnId, callId, taskId, command });
  }

  /**
   * A background task ended (ADR-111).
   *
   * `turnId` is null on purpose: the task outlives the turn that started it, and attaching
   * its end to whatever turn happens to be open would be a lie a replay would repeat.
   */
  async backgroundFinished(input: {
    readonly callId: string;
    readonly taskId: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly state: BackgroundEndState;
    readonly reason: TerminationReason;
    readonly facts: ExecutionFacts | null;
    readonly tail: string;
    readonly truncated: boolean;
    readonly dropped: number;
  }): Promise<void> {
    await this.emit({ type: 'tool.background.finished', turnId: null, ...input });
  }

  /** A cron job was created by this turn's tool call (ADR-140); the host minted the fact. */
  async cronCreated(ref: CronCreatedRef): Promise<void> {
    const turnId = this.turnId;
    if (turnId === null) throw new Error('cronCreated outside a turn');
    await this.emit({ type: 'cron.created', turnId, ...ref });
  }

  /**
   * A cron job was deleted (ADR-140). Reachable from both sides: the kernel, after a
   * CronDelete tool call (`by: 'model'`), and the host, answering the `/cron` panel
   * (`by: 'user'`). `by` is the audit's word for who ended the job.
   */
  async cronDeleted(jobId: string, by: 'user' | 'model' | 'expiry', deletedAt: number): Promise<void> {
    await this.emit({ type: 'cron.deleted', turnId: null, jobId, by, deletedAt });
  }

  async openTurn(
    input: string,
    opening: { readonly model?: string; readonly contextWindow?: number; readonly price?: PriceTable } = {},
    /**
     * A caller-reserved turn id. Only the cron scheduler uses this (ADR-140 ②): its
     * `cron.fired` event names the turn before it exists, and the turn must open under
     * that name or the audit link breaks. Every other caller lets the session mint.
     */
    reservedTurnId?: string,
  ): Promise<string> {
    const current = this.#state.turn?.state;
    if (current !== undefined && !isTerminal(current)) throw new Error('a turn is already open');
    const turnId = reservedTurnId ?? this.#deps.ids.next('turn');
    await this.emit({
      type: 'turn.opened',
      turnId,
      input,
      ...(opening.model === undefined || opening.model === '' ? {} : { model: opening.model }),
      // A non-positive window is not a window: the schema says positive, and a status bar
      // that divided by it would print a number nobody can act on.
      ...(opening.contextWindow === undefined || opening.contextWindow <= 0
        ? {}
        : { contextWindow: opening.contextWindow }),
      ...(opening.price === undefined ? {} : { price: opening.price }),
    });
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

// A snapshot is an accelerator, never a source of truth: it is used only when it still
// describes this log, and otherwise the log alone decides the state. Every rejection
// here costs replay time, never correctness (ADR-013).
function stateFrom(
  sessionId: string,
  events: readonly KernelEvent[],
  snapshot: SessionSnapshot | null,
): SessionState {
  if (snapshot === null) return replay(sessionId, events);
  if (!isSupportedSchemaVersion(snapshot.schemaVersion)) return replay(sessionId, events);
  // Covered events are a prefix of the log, and `seq` runs 1..n in step with the line
  // number, so a snapshot that claims more events than the log holds is stale or from
  // another file. The store is append-only, so a prefix can never be rewritten underneath.
  if (snapshot.lastSeq > events.length) return replay(sessionId, events);
  return events.slice(snapshot.lastSeq).reduce(reduce, snapshot.state);
}
