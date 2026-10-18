import { ERROR_CODES, type ErrorCode } from './jsonrpc.js';
import type { AttachmentBytes, ApprovalVerdict, SessionSummary } from './methods.js';

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
}

export interface ProtocolHost {
  readonly serverVersion: string;
  listSessions(): Promise<readonly SessionSummary[]>;
  /** `null` asks the host to mint the id — it has the id source, this layer does not. */
  createSession(sessionId: string | null): Promise<SessionSummary>;
  attach(sessionId: string): Promise<AttachedSession>;
  sendTurn(sessionId: string, input: string): Promise<{ turnId: string }>;
  cancelTurn(sessionId: string): Promise<void>;
  respondApproval(sessionId: string, callId: string, verdict: ApprovalVerdict): Promise<void>;
  /** `null` means the host's own limit only; the caller's cap is applied by the host. */
  readAttachment(id: string, maxBytes: number | null): Promise<AttachmentBytes>;
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
