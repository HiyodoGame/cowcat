import type { ExecutionFacts, SandboxProfile, TerminationReason } from './process.js';

/**
 * Background tasks — a command the model deliberately started to outlive its turn (ADR-110).
 *
 * The port is the host's registry, not the kernel's: a session log is a record of what
 * happened, and a process that is still running is not a fact until it ends. The kernel only
 * learns about starts and ends through events (ADR-111).
 *
 * Deliberately NOT here: a pid. `ProcessPort.run` cannot report one, and a pid is only
 * meaningful inside one host lifetime — the task id is the handle a frontend can hold.
 */

/** What to start. Everything the gateway needs, already resolved by the caller. */
export interface BackgroundStart {
  /** Which session owns the task, so an exit can be routed back to its log. */
  readonly sessionId: string;
  /** The tool call that started it. */
  readonly callId: string;
  /** The command as the model wrote it, for the started/ finished events and the panel. */
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sandbox: SandboxProfile;
  /**
   * Wall-clock cap. The registry passes it to the gateway, which owns termination.
   */
  readonly timeoutMs: number;
}

export interface BackgroundTask {
  readonly taskId: string;
}

/**
 * The part of a started task that belongs in the log and in the tool result (ADR-111).
 *
 * `command` is kept so the event explains itself without a join against an earlier
 * `model.message`; the session and the call are already in the event envelope.
 */
export interface BackgroundTaskRef {
  readonly taskId: string;
  readonly command: string;
}

/** A running task, as the panel needs it. */
export interface BackgroundTaskInfo extends BackgroundTask {
  readonly sessionId: string;
  readonly callId: string;
  readonly command: string;
  readonly startedAt: number;
}

/**
 * How a task ended.
 *
 * `exited` ran to the end, `stopped` was terminated on purpose (user, timeout, shutdown),
 * `lost` means the host could not prove the process tree was gone — the same word the
 * gateway uses for `residuePossible`, and it must not be read as "it ended cleanly".
 */
export type BackgroundEndState = 'exited' | 'stopped' | 'lost';

export interface BackgroundExit {
  readonly taskId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly state: BackgroundEndState;
  readonly reason: TerminationReason;
  /**
   * What the gateway actually did (ADR-033): sandbox, termination record, removed env.
   * `null` only for a `lost` exit that never produced a result, so "not known" stays
   * distinguishable from "no sandbox".
   */
  readonly facts: ExecutionFacts | null;
  /** The tail kept for the record, bounded by the registry's tail cap. stdout and stderr are
   *  merged in arrival order — a background task is read as one stream, not two. */
  readonly tail: string;
  readonly truncated: boolean;
  readonly dropped: number;
}

export interface BackgroundTasksPort {
  /**
   * Rejects when the command could not be started. The rejection covers only failures the
   * gateway can see immediately (a missing executable, an unusable sandbox); a failure that
   * arrives later is reported as a `lost` exit, because by then a task id exists.
   */
  start(spec: BackgroundStart): Promise<BackgroundTask>;
  /** Abort one task. False only when the id is not in the registry any more — a task that
   *  finishes between this lookup and the abort still returns true, and its exit event says
   *  what actually happened. */
  stop(taskId: string): Promise<boolean>;
  list(): readonly BackgroundTaskInfo[];
  /** Fires once per task, after its streams are drained. Returns an unsubscribe function. */
  onExit(listener: (exit: BackgroundExit) => void): () => void;
  /** Abort everything and wait for the exits. The host calls this on close (ADR-112). */
  stopAll(): Promise<void>;
}
