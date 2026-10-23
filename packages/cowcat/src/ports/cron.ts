/**
 * Cron tasks — scheduled prompts that fire as turns while the user is away (ADR-140~143).
 *
 * The port is the host's service, exactly the shape BackgroundTasksPort sets: the tools
 * talk to it, but every mutation lands in the SESSION LOG as a `cron.*` event (the kernel
 * turns ToolResult extensions into events, the `background` precedent). The port holds no
 * truth: its answers are computed from the log's projection, so replay and resume agree
 * with it by construction.
 *
 * Deliberately NOT here: the parsed schedule. Tools parse (they reject malformed input
 * with `ok: false` before anything is written); the port re-parses what it is asked to
 * schedule, because a port that trusts its caller's parse can be handed a lie.
 */

/** What CronCreate asks the host to register. */
export interface CronCreateRequest {
  /** The 5-field expression as the model wrote it. */
  readonly schedule: string;
  /** The prompt the scheduled turn will run. */
  readonly prompt: string;
  readonly recurring: boolean;
}

/**
 * The fact a successful create hands back: everything `cron.created` records.
 * The host mints `jobId`, stamps `createdAt`, and computes `expiresAt` (ADR-141 ⑤),
 * so the tool cannot forge any of the three.
 */
export interface CronCreatedRef {
  readonly jobId: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export type CronCreateOutcome =
  | { readonly ok: true; readonly job: CronCreatedRef; /** Next fire in ms; null for a schedule with no fire in the horizon. */ readonly nextRun: number | null }
  | { readonly ok: false; /** Why: a bad schedule, the session cap (ADR-141 ③), or the job table itself. */ readonly error: string };

/** One live job as the panel, the CronList tool, and the scheduler all need it. */
export interface CronJobInfo {
  readonly jobId: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  /** Next scheduled fire in ms (not "when it will actually run" — a long turn delays that). */
  readonly nextRun: number | null;
  /** Last fire in ms, or null when never fired. */
  readonly lastFiredAt: number | null;
}

export interface CronTasksPort {
  /**
   * Validates (schedule syntax, live-job cap) and mints the identity. `ok: false` means
   * NOTHING was scheduled — the tool reports the error to the model, no event is written.
   * The port writes no events at all: the kernel logs `cron.created` from the tool
   * result, so there is exactly one writer (ADR-140).
   */
  create(sessionId: string, request: CronCreateRequest): Promise<CronCreateOutcome>;
  /**
   * Ownership/existence check for a delete. False when the id is not live in THIS
   * session — one session's tooling must not reach into another session's job table.
   * Writes nothing: the event is the caller's job (the kernel for a model's CronDelete,
   * the host for a `/cron` panel removal), keeping one writer per fact.
   */
  remove(sessionId: string, jobId: string): Promise<boolean>;
  /** The live projection for one session: everything its log says is scheduled. */
  list(sessionId: string): Promise<readonly CronJobInfo[]>;
}
