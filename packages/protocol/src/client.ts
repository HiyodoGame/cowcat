import {
  ERROR_CODES,
  parseResponse,
  serializeRequest,
  settle,
  type JsonRpcResponse,
  type RequestId,
} from './jsonrpc.js';
import type { AttachmentBytes, MethodName, Params, Result, ResultTable, SessionSummary } from './methods.js';
import { parseNotification, type NotificationName, type NotificationParams } from './notifications.js';
import { PROTOCOL_VERSION } from './version.js';
import type { Transport } from './transport.js';

export interface ClientOptions {
  readonly transport: Transport;
  readonly protocolVersion?: number;
}

/** A failure the server reported, or one this client raised about the transport. */
export class ProtocolClientError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, code: number, data: unknown = null) {
    super(message);
    this.name = 'ProtocolClientError';
    this.code = code;
    this.data = data;
  }
}

export interface ProtocolClient {
  readonly protocolVersion: number;
  /** The handshake. Resolves with the server's version, or rejects on a mismatch. */
  initialize(): Promise<ResultTable['initialize']>;
  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  /** Convenience wrappers over `request`, so callers do not hand-write params. */
  listSessions(): Promise<readonly SessionSummary[]>;
  createSession(sessionId?: string): Promise<SessionSummary>;
  openSession(sessionId: string): Promise<ResultTable['session.open']>;
  forkSession(sessionId: string): Promise<string>;
  sendTurn(sessionId: string, input: string, files?: readonly string[]): Promise<string>;
  cancelTurn(sessionId: string): Promise<void>;
  respondApproval(sessionId: string, callId: string, verdict: Params<'approval.respond'>['verdict']): Promise<void>;
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
  respondPlan(sessionId: string, callId: string, choice: number | null, reason: string | null): Promise<void>;
  readAttachment(id: string, maxBytes?: number): Promise<AttachmentBytes>;
  /** Stop a background task this session started; false when it is already gone. */
  stopTask(sessionId: string, taskId: string): Promise<boolean>;
  shutdown(): Promise<void>;
  on<N extends NotificationName>(name: N, handler: (params: NotificationParams[N]) => void): () => void;
  /** Resolves when the transport closes, whoever closed it. */
  readonly closed: Promise<void>;
  close(): void;
}

/**
 * The client half. It holds no session state and makes no decisions about one: it
 * correlates replies with requests and hands notifications to whoever subscribed
 * (06-frontend.md: the frontend owns only its own UI state, never a copy of the
 * session).
 *
 * Results are *not* re-validated field by field. The handshake is what makes them
 * trustworthy: a server whose `protocolVersion` matches is a server whose result
 * shapes this build knows, and validating them again would buy nothing but a second
 * copy of `ResultTable`. Params go the other way and *are* validated — by the server,
 * which is the side that must not act on a malformed request.
 */
export function createClient(options: ClientOptions): ProtocolClient {
  const { transport } = options;
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  let nextId = 1;
  let closedByUs = false;
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const offMessage = transport.onMessage((line) => {
    const response = parseResponse(line);
    if (response !== null) {
      correlate(response);
      return;
    }
    // Not a response: either a notification for a subscriber, or (a bug's) junk.
    const notification = parseNotification(line);
    if (notification !== null) dispatch(notification);
  });
  const offClose = transport.onClose(() => {
    rejectAll(new ProtocolClientError('transport closed', ERROR_CODES.internalError));
    resolveClosed?.();
  });

  function correlate(response: JsonRpcResponse): void {
    const id = response.id ?? -1;
    const waiter = pending.get(id);
    if (waiter === undefined) return; // late reply to a request already rejected
    pending.delete(id);
    const result = settle(response);
    if (result.ok) waiter.resolve(result.result);
    else waiter.reject(new ProtocolClientError(result.error.message, result.error.code, result.error.data ?? null));
  }

  function dispatch(notification: { readonly name: NotificationName; readonly params: unknown }): void {
    const handlers = notificationHandlers.get(notification.name);
    if (handlers === undefined) return;
    for (const handler of handlers) handler(notification.params);
  }

  function rejectAll(error: Error): void {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  function request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (closedByUs) {
      // Rejecting beats queueing: a caller that awaits a promise which can never
      // settle is a hung UI, and hanging is worse than an error it can show.
      return Promise.reject(new ProtocolClientError('client is closed', ERROR_CODES.internalError));
    }
    const id: RequestId = nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => {
          resolve(value as Result<M>);
        },
        reject,
      });
      transport.send(serializeRequest({ jsonrpc: '2.0', id, method, params }));
    });
  }

  return {
    protocolVersion,
    closed,

    async initialize(): Promise<ResultTable['initialize']> {
      const result = await request('initialize', { protocolVersion });
      if (result.protocolVersion !== protocolVersion) {
        // The server said it agrees but reported another generation: refuse here too,
        // rather than render against a version nobody negotiated.
        throw new ProtocolClientError(
          `server reported protocol version ${String(result.protocolVersion)}`,
          ERROR_CODES.versionMismatch,
        );
      }
      return result;
    },

    request,

    async listSessions() {
      return (await request('session.list', {})).sessions;
    },

    async createSession(sessionId?: string) {
      return request('session.create', sessionId === undefined ? {} : { sessionId });
    },

    async openSession(sessionId: string) {
      return request('session.open', { sessionId });
    },

    async forkSession(sessionId: string) {
      return (await request('session.fork', { sessionId })).sessionId;
    },

    async sendTurn(sessionId: string, input: string, files?: readonly string[]) {
      return (await request('turn.send', { sessionId, input, ...(files === undefined ? {} : { files: [...files] }) })).turnId;
    },

    async cancelTurn(sessionId: string) {
      await request('turn.cancel', { sessionId });
    },

    async respondApproval(sessionId: string, callId: string, verdict: Params<'approval.respond'>['verdict']) {
      await request('approval.respond', { sessionId, callId, verdict });
    },

    async setPlanMode(sessionId: string, enabled: boolean) {
      await request('plan.setMode', { sessionId, enabled });
    },

    async respondPlan(sessionId: string, callId: string, choice: number | null, reason: string | null) {
      await request('plan.reply', { sessionId, callId, choice, reason });
    },

    async readAttachment(id: string, maxBytes?: number) {
      return request('attachment.read', maxBytes === undefined ? { id } : { id, maxBytes });
    },

    async stopTask(sessionId: string, taskId: string) {
      const result = await request('task.stop', { sessionId, taskId });
      return result.stopped;
    },

    async shutdown() {
      await request('shutdown', {});
    },

    on<N extends NotificationName>(name: N, handler: (params: NotificationParams[N]) => void): () => void {
      const handlers = notificationHandlers.get(name) ?? new Set<(params: unknown) => void>();
      notificationHandlers.set(name, handlers);
      const wrapped = (params: unknown): void => {
        handler(params as NotificationParams[N]);
      };
      handlers.add(wrapped);
      return () => handlers.delete(wrapped);
    },

    close(): void {
      closedByUs = true;
      rejectAll(new ProtocolClientError('client closed', ERROR_CODES.internalError));
      offMessage();
      offClose();
      transport.close();
      resolveClosed?.();
    },
  };
}

/**
 * The notifications on a transport, decoded. Split from the client so a test (or a
 * transport-only consumer such as a log recorder) can read them without a client.
 */
export function onNotification<N extends NotificationName>(
  transport: Transport,
  name: N,
  handler: (params: NotificationParams[N]) => void,
): () => void {
  return transport.onMessage((line) => {
    const notification = parseNotification(line);
    if (notification?.name === name) handler(notification.params as NotificationParams[N]);
  });
}
