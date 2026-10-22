import type {
  BackgroundEndState,
  BackgroundExit,
  BackgroundStart,
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTasksPort,
  ProcessPort,
  ProcessResult,
} from '../ports/index.js';
import { OutputTail } from './output-tail.js';

/**
 * The host's background-task registry (ADR-110).
 *
 * A background command is the same gateway call as a foreground one, just not awaited by
 * the tool: `run()` performs sandbox resolution, env redaction, timeout and tree
 * termination exactly as before, and this class keeps the promise instead of the caller.
 * That is also why there is no pid here — the gateway does not expose one, and a pid is
 * only meaningful inside one host's lifetime.
 *
 * The tail kept for the exit event is bounded (2,000 characters by default): the live view
 * already saw the stream, and a finished event is a record, not a log file.
 */

export interface NodeBackgroundTasksOptions {
  readonly process: ProcessPort;
  readonly now?: () => number;
  readonly tailCap?: number;
}

const DEFAULT_TAIL_CAP = 2_000;

interface Running {
  readonly info: BackgroundTaskInfo;
  readonly controller: AbortController;
  done: Promise<void>;
  /**
   * Set once `start()` has decided to hand the id out. An exit that arrives before that is
   * held, so no listener ever sees the end of a task whose id a caller has not been given.
   */
  announced: boolean;
  held: BackgroundExit | null;
}

export class NodeBackgroundTasks implements BackgroundTasksPort {
  readonly #process: ProcessPort;
  readonly #now: () => number;
  readonly #tailCap: number;
  readonly #tasks = new Map<string, Running>();
  readonly #listeners = new Set<(exit: BackgroundExit) => void>();
  #next = 0;

  constructor(options: NodeBackgroundTasksOptions) {
    this.#process = options.process;
    this.#now = options.now ?? Date.now;
    this.#tailCap = Math.max(0, options.tailCap ?? DEFAULT_TAIL_CAP);
  }

  async start(spec: BackgroundStart): Promise<BackgroundTask> {
    const taskId = `bg_${String((this.#next += 1))}`;
    const info: BackgroundTaskInfo = {
      taskId,
      sessionId: spec.sessionId,
      callId: spec.callId,
      command: spec.command,
      startedAt: this.#now(),
    };
    const controller = new AbortController();
    const tail = new OutputTail(this.#tailCap);

    const run = this.#process.run(
      {
        argv: spec.argv,
        cwd: spec.cwd,
        env: spec.env,
        sandbox: spec.sandbox,
        timeoutMs: spec.timeoutMs,
        // One knob: the gateway keeps what the exit event is allowed to report, and nothing
        // more (a background task is a record, not a log file).
        outputCap: this.#tailCap,
      },
      controller.signal,
      { onOutput: (_stream, text) => {
        tail.push(text);
      } },
    );

    // A failure BEFORE start() returns is the caller's problem (it gets an exception); a
    // failure after is an exit event, because by then the caller has a task id it may
    // already have written to the log.
    const entry: Running = { info, controller, done: Promise.resolve(), announced: false, held: null };
    entry.done = run.then(
      (result) => {
        this.#finish(entry, result, tail);
      },
      () => {
        this.#tasks.delete(taskId);
        this.#deliver(entry, this.#lostExit(info, tail));
      },
    );
    this.#tasks.set(taskId, entry);

    // A spawn failure rejects on the next tick; wait one immediate so "cannot start" is an
    // exception rather than a task id handing out a promise that never ran.
    const failure = await Promise.race([
      run.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<undefined>((resolve) => {
        setImmediate(() => {
          resolve(undefined);
        });
      }),
    ]);
    if (failure !== undefined) {
      await entry.done;
      if (failure instanceof Error) throw failure;
      throw new Error('the command could not be started');
    }
    // Hand the id out before any listener hears how it ended. The immediate makes "before"
    // true for the caller too: its await resumes on the microtask queue, ahead of this.
    entry.announced = true;
    const held = entry.held;
    entry.held = null;
    if (held !== null) {
      setImmediate(() => {
        this.#emit(held);
      });
    }
    return { taskId };
  }

  async stop(taskId: string): Promise<boolean> {
    const entry = this.#tasks.get(taskId);
    if (entry === undefined) return false;
    entry.controller.abort();
    await entry.done;
    return true;
  }

  list(): readonly BackgroundTaskInfo[] {
    return [...this.#tasks.values()].map((entry) => ({ ...entry.info }));
  }

  onExit(listener: (exit: BackgroundExit) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async stopAll(): Promise<void> {
    const entries = [...this.#tasks.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.done));
  }

  #finish(entry: Running, result: ProcessResult, tail: OutputTail): void {
    const { info } = entry;
    this.#tasks.delete(info.taskId);
    this.#deliver(entry, {
      taskId: info.taskId,
      sessionId: info.sessionId,
      callId: info.callId,
      exitCode: result.exitCode,
      signal: result.signal,
      // `residuePossible` is the gateway saying "I could not prove the tree is gone"; the
      // only honest word for that is `lost`, not `stopped`.
      state: endStateOf(result),
      reason: result.termination.reason,
      facts: {
        sandbox: result.sandbox,
        termination: result.termination,
        removedEnv: result.removedEnv,
        ignoredDeny: result.ignoredDeny,
      },
      tail: tail.text,
      truncated: tail.dropped > 0,
      dropped: tail.dropped,
    });
  }

  #lostExit(info: BackgroundTaskInfo, tail: OutputTail): BackgroundExit {
    return {
      taskId: info.taskId,
      sessionId: info.sessionId,
      callId: info.callId,
      exitCode: null,
      signal: null,
      state: 'lost',
      reason: 'none',
      facts: null,
      tail: tail.text,
      truncated: tail.dropped > 0,
      dropped: tail.dropped,
    };
  }

  /** Hold an exit until `start()` has handed the id out; emit it after that. */
  #deliver(entry: Running, exit: BackgroundExit): void {
    if (!entry.announced) {
      entry.held = exit;
      return;
    }
    this.#emit(exit);
  }

  #emit(exit: BackgroundExit): void {
    // A snapshot: a listener registered by another listener should not receive the event
    // that was already being delivered.
    for (const listener of [...this.#listeners]) {
      try {
        listener(exit);
      } catch {
        // A listener that throws (a log being closed, a panel mid-teardown) must not turn
        // one task's exit into an unhandled rejection or rob the other listeners of it.
      }
    }
  }
}

function endStateOf(result: ProcessResult): BackgroundEndState {
  if (result.termination.residuePossible) return 'lost';
  return result.termination.reason === 'none' ? 'exited' : 'stopped';
}
