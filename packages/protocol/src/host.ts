import { ERROR_CODES, type ErrorCode } from './jsonrpc.js';
import type { AttachmentBytes, ApprovalVerdict, CronJobSummary, GrantSummary, ModelListResult, ModelSelectionSummary, ProviderConfiguration, ProviderSummary, SessionSummary, TrustWithheld } from './methods.js';

/**
 * What the frontend needs from whatever holds sessions. T3/T4 implement this over the
 * kernel; nothing here knows that.
 *
 * It is a port in the kernel's own sense: the frontend reaches the kernel only through
 * the protocol and never imports its internals (ADR-059 ③), so the conversation has to
 * be describable without them.
 *
 * Updates are `unknown` on purpose. An update is a `KernelEvent` or a `StreamDelta`,
 * and carrying it is this layer's job while understanding it is the renderer's
 * (`app/project()`, T7). The server checks the envelope before sending (see
 * `notifications.ts`), so a host that hands over something else is caught here rather
 * than in a terminal.
 */
export interface AttachedSession {
  readonly lastSeq: number;
  /** The log so far, oldest first, in the order it would be replayed. */
  readonly replay: readonly unknown[];
  /**
   * Returns the unsubscribe. The server owns the lifetime: it unsubscribes on
   * `shutdown` and on transport close, because a kernel session with an abandoned
   * listener keeps a dead renderer alive.
   *
   * **Contract**: `replay` is the log up to `lastSeq`, and the subscription starts
   * exactly there — no update may be lost between the two, and none may appear in
   * both. A host that reads the state and then subscribes has a gap; a host that
   * subscribes and then reads has duplicates. `session.open` relies on this (it
   * answers, then sends the replay), and `project()`'s "same log → same screen"
   * promise (ADR-059 ②) fails quietly if it is broken.
   */
  subscribe(listener: (update: unknown) => void): () => void;
  /**
   * Everything the session has been billed, summed (ADR-131 ①). Derived from the log's
   * `model.usage` events, never stored: a client that ignores it loses a meter, not a
   * fact — replaying the log recomputes it exactly. Absent when every usage field is
   * zero is unnecessary: zero totals are honest for a fresh session.
   */
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
  };
}

export interface ProtocolHost {
  readonly serverVersion: string;
  listSessions(): Promise<readonly SessionSummary[]>;
  /** `null` asks the host to mint the id — it has the id source, this layer does not. */
  createSession(sessionId: string | null): Promise<SessionSummary>;
  attach(sessionId: string): Promise<AttachedSession>;
  /** Fork a session by replaying its log into a new one (ADR-127); refuses a running turn. */
  forkSession(sessionId: string): Promise<{ readonly sessionId: string }>;
  /**
   * `files` are `@` references (absolute paths): validated and read by the host, which
   * emits `prompt.attached` before the turn opens (ADR-128). A bad file refuses the
   * whole send, never half of it.
   */
  sendTurn(sessionId: string, input: string, files?: readonly string[]): Promise<{ turnId: string; queued?: boolean }>;
  cancelTurn(sessionId: string): Promise<void>;
  listModels(sessionId: string): Promise<ModelListResult>;
  setModel(sessionId: string, preset: string, effort?: string | null): Promise<{ readonly current: ModelSelectionSummary }>;
  compactSession(sessionId: string): Promise<{ readonly compacted: boolean; readonly dropped: number; readonly reason: string | null }>;
  listGrants(sessionId: string): Promise<{ readonly grants: readonly GrantSummary[] }>;
  revokeGrant(sessionId: string, grantId: string): Promise<{ readonly revoked: boolean }>;
  undoChange(sessionId: string): Promise<{ readonly path: string }>;
  redoChange(sessionId: string): Promise<{ readonly path: string }>;
  respondApproval(sessionId: string, callId: string, verdict: ApprovalVerdict): Promise<void>;
  /**
   * Toggle plan mode (ADR-124 ⑥). A user act, never model-initiated; the change lands
   * in the session log as `plan.mode-changed`.
   */
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
  /**
   * Toggle accept-edits mode (ADR-159 ③): Write/Edit asks are pre-answered for the
   * session. Also a user act; logged as `accept-edits.mode-changed`, no standing grant.
   */
  setAcceptEdits(sessionId: string, enabled: boolean): Promise<void>;
  /** Answer a plan review (ADR-125 ③). `choice: null` means "none of them" (reason tells why). */
  respondPlan(sessionId: string, callId: string, choice: number | null, reason: string | null): Promise<void>;
  /** `null` means the host's own limit only; the caller's cap is applied by the host. */
  readAttachment(id: string, maxBytes: number | null): Promise<AttachmentBytes>;
  /**
   * Stop a background task the session started (ADR-113). False when the task is already
   * gone or does not belong to this session — never a silent success.
   */
  stopTask(sessionId: string, taskId: string): Promise<boolean>;
  /** The session's scheduled jobs, newest facts included (ADR-143 ②). Empty when cron is off in this build. */
  listCronJobs(sessionId: string): Promise<readonly CronJobSummary[]>;
  /**
   * Remove one of the session's cron jobs (the `/cron` panel's delete). False when the
   * id is not this session's live job — never a silent success. The removal lands in
   * the log as `cron.deleted by: 'user'`, so replay and other clients see it.
   */
  removeCronJob(sessionId: string, jobId: string): Promise<boolean>;
  /** The user layer's providers with key detection (ADR-165 ①). */
  listProviders(): Promise<{ readonly providers: readonly ProviderSummary[] }>;
  /**
   * Write one provider entry into the user config (ADR-165 ①). The secret itself is
   * carried by the environment, never the wire — `apiKeyEnv` is a NAME.
   */
  setProvider(name: string, fields: { readonly baseUrl?: string; readonly apiKeyEnv?: string }): Promise<void>;
  configureProvider(sessionId: string, configuration: ProviderConfiguration): Promise<{
    readonly saved: true;
    readonly current: ModelSelectionSummary | null;
    readonly keySet: boolean;
    readonly requiresRestart: boolean;
  }>;
  /**
   * The host's startup trust snapshot for its own cwd (ADR-157 ②): whether it is trusted
   * and what the project layer is holding back. Read-only — the host never hot-reloads
   * config; a grant takes effect on the next host build.
   */
  trustStatus(): Promise<{ readonly trusted: boolean; readonly withheld: TrustWithheld }>;
  /**
   * Append the startup cwd to the persistent trust store (ADR-157 ②). The running host's
   * snapshot is unchanged; the caller rebuilds the host (the TUI's reconnect factory) to
   * pick up the project layer.
   */
  trustGrant(): Promise<void>;
}

/**
 * A failure the host can describe to the client. The code is part of the reply, so a
 * client can say "that session is gone" instead of printing a stack trace.
 */
export class ProtocolHostError extends Error {
  readonly code: ErrorCode;
  readonly data: unknown;

  constructor(message: string, code: ErrorCode = ERROR_CODES.hostRefused, data: unknown = null) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.data = data;
  }
}

export class NoSuchSessionError extends ProtocolHostError {
  constructor(sessionId: string) {
    super(`no such session: ${sessionId}`, ERROR_CODES.noSuchSession);
  }
}

/** Refused, not clipped: ADR-057 says oversized bytes are an error with a reason. */
export class AttachmentTooLargeError extends ProtocolHostError {
  constructor(id: string, byteLength: number, limit: number) {
    super(`attachment ${id} is ${String(byteLength)} bytes, over the ${String(limit)} byte limit`, ERROR_CODES.attachmentTooLarge, {
      id,
      byteLength,
      limit,
    });
  }
}
