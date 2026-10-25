import { ProtocolHostError, type AttachedSession, type ProtocolHost } from './host.js';
import {
  ERROR_CODES,
  parseIncoming,
  serializeError,
  serializeNotification,
  serializeResult,
  type JsonRpcError,
  type JsonRpcRequest,
  type RequestId,
} from './jsonrpc.js';
import { METHODS, PARAMS, isMethodName, type MethodName, type Params, type ResultTable } from './methods.js';
import { NOTIFICATIONS, deltaParamsSchema, isWireEvent } from './notifications.js';
import type { Transport } from './transport.js';
import { PROTOCOL_VERSION } from './version.js';

export { PROTOCOL_VERSION };

export interface ServerOptions {
  readonly host: ProtocolHost;
  readonly transport: Transport;
  /** Tests drive a fake generation through this; the product never passes it. */
  readonly protocolVersion?: number;
}

export interface ProtocolServer {
  /** Resolves once the transport is closed, for any reason. */
  readonly closed: Promise<void>;
  close(): void;
}

/**
 * The server side of the protocol, minus its transport and minus its host.
 *
 * Both omissions are the point. The transport is injected, so the identical dispatch
 * runs over stdio (T3) and over a pair of in-process queues (ADR-059 ① — the contract
 * tests never spawn a process). The host is a port, so this file never learns that a
 * kernel exists and `packages/cowcat/src/kernel/*` stays unreachable from the
 * frontend (ADR-059 ③).
 */
export function createServer(options: ServerOptions): ProtocolServer {
  const { host, transport } = options;
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;

  const attached = new Map<string, { readonly session: AttachedSession; readonly unsubscribe: () => void }>();
  let initialized = false;
  let stopped = false;
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const offMessage = transport.onMessage((line) => {
    void handle(line);
  });
  const offClose = transport.onClose(() => {
    stop();
  });

  function send(line: string): void {
    // After a refusal the server is on its way out; a late reply would be a reply to
    // a request nobody is waiting for any more.
    if (!stopped) transport.send(line);
  }

  function reply(id: RequestId, result: unknown): void {
    send(serializeResult(id, result));
  }

  function replyError(id: RequestId | null, error: JsonRpcError): void {
    send(serializeError(id, error));
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const { unsubscribe } of attached.values()) unsubscribe();
    attached.clear();
    offMessage();
    offClose();
    transport.close();
    resolveClosed?.();
  }

  async function handle(line: string): Promise<void> {
    const incoming = parseIncoming(line);
    if (incoming.kind === 'invalid') {
      replyError(incoming.id, incoming.error);
      return;
    }
    if (incoming.kind === 'notification') {
      // The protocol defines no client-to-server notification, and JSON-RPC asks for
      // no answer to one. Answering would invent a reply the client never awaits.
      return;
    }
    await dispatch(incoming.request);
  }

  async function dispatch(request: JsonRpcRequest): Promise<void> {
    const { method } = request;
    if (!isMethodName(method)) {
      replyError(request.id, {
        code: ERROR_CODES.methodNotFound,
        message: `unknown method: ${method}`,
        data: { known: METHODS },
      });
      return;
    }
    if (method !== 'initialize' && !initialized) {
      replyError(request.id, {
        code: ERROR_CODES.notInitialized,
        message: 'initialize must be the first request',
      });
      return;
    }

    const parsed = PARAMS[method].safeParse(request.params ?? {});
    if (!parsed.success) {
      replyError(request.id, {
        code: ERROR_CODES.invalidParams,
        message: `invalid params for ${method}`,
        data: parsed.error.issues,
      });
      return;
    }

    try {
      // The schema above already proved the shape; the casts only tell the compiler
      // what the switch already knows. Every params type here comes from its schema
      // (`Params<M> = z.infer<typeof PARAMS[M]>`), so there is no second description
      // of it to drift.
      await run(method, parsed.data, request.id);
    } catch (error) {
      replyError(request.id, describe(error));
    }
  }

  async function run(method: MethodName, params: unknown, id: RequestId): Promise<void> {
    switch (method) {
      case 'initialize':
        // The two methods that answer synchronously are statements plus a bare
        // `return`, so the switch does not hand back a `void` expression as a result.
        initialize(id, params as Params<'initialize'>);
        return;
      case 'session.open':
        return openSession(id, params as Params<'session.open'>);
      case 'session.create':
        return createSession(id, params as Params<'session.create'>);
      case 'session.fork':
        return forkSession(id, params as Params<'session.fork'>);
      case 'session.list':
        return listSessions(id);
      case 'turn.send':
        return sendTurn(id, params as Params<'turn.send'>);
      case 'turn.cancel':
        return cancelTurn(id, params as Params<'turn.cancel'>);
      case 'model.list':
        return listModels(id, params as Params<'model.list'>);
      case 'model.set':
        return setModel(id, params as Params<'model.set'>);
      case 'context.compact':
        return compactSession(id, params as Params<'context.compact'>);
      case 'grants.list':
        return listGrants(id, params as Params<'grants.list'>);
      case 'grants.revoke':
        return revokeGrant(id, params as Params<'grants.revoke'>);
      case 'change.undo':
        return undoChange(id, params as Params<'change.undo'>);
      case 'change.redo':
        return redoChange(id, params as Params<'change.redo'>);
      case 'approval.respond':
        return respondApproval(id, params as Params<'approval.respond'>);
      case 'plan.setMode':
        return setPlanMode(id, params as Params<'plan.setMode'>);
      case 'plan.reply':
        return respondPlan(id, params as Params<'plan.reply'>);
      case 'attachment.read':
        return readAttachment(id, params as Params<'attachment.read'>);
      case 'task.stop':
        return stopTask(id, params as Params<'task.stop'>);
      case 'cron.list':
        return listCronJobs(id, params as Params<'cron.list'>);
      case 'cron.remove':
        return removeCronJob(id, params as Params<'cron.remove'>);
      case 'trust.status':
        return trustStatus(id);
      case 'trust.grant':
        return trustGrant(id);
      case 'shutdown':
        shutdown(id);
        return;
      default: {
        // Exhaustiveness: adding a method to the table without handling it fails to
        // compile rather than falling through to a silent no-response.
        const unreachable: never = method;
        throw new Error(`unhandled method: ${String(unreachable)}`);
      }
    }
  }

  function initialize(id: RequestId, params: Params<'initialize'>): void {
    if (initialized) {
      replyError(id, { code: ERROR_CODES.invalidRequest, message: 'already initialized' });
      return;
    }
    if (params.protocolVersion !== protocolVersion) {
      // The error goes out first, then the server stops: refusing means stopping, not
      // "continuing in the hope the rest lines up" (ADR-055, and ADR-016 before it).
      replyError(id, {
        code: ERROR_CODES.versionMismatch,
        message: `protocol version ${String(params.protocolVersion)} is not supported`,
        data: { supported: protocolVersion },
      });
      stop();
      return;
    }
    initialized = true;
    const result: ResultTable['initialize'] = { protocolVersion, serverVersion: host.serverVersion };
    reply(id, result);
  }

  async function openSession(id: RequestId, params: Params<'session.open'>): Promise<void> {
    const session = await host.attach(params.sessionId);

    // A client has one active session: replacing it detaches every earlier session,
    // not only the same id. Otherwise A→B leaves A's tools and approvals reaching B.
    for (const previous of attached.values()) previous.unsubscribe();
    attached.clear();
    const unsubscribe = session.subscribe(notify);
    attached.set(params.sessionId, { session, unsubscribe });

    // The reply precedes the replay so the client can register the session before the
    // first event of it arrives; both go through the same ordered transport.
    reply(id, {
      sessionId: params.sessionId,
      lastSeq: session.lastSeq,
      replayed: session.replay.length,
      ...(session.usage === undefined ? {} : { usage: session.usage }),
    });
    for (const update of session.replay) notify(update);
  }

  async function createSession(id: RequestId, params: Params<'session.create'>): Promise<void> {
    const created = await host.createSession(params.sessionId ?? null);
    reply(id, created);
  }

  async function forkSession(id: RequestId, params: Params<'session.fork'>): Promise<void> {
    reply(id, await host.forkSession(params.sessionId));
  }

  async function listSessions(id: RequestId): Promise<void> {
    reply(id, { sessions: await host.listSessions() });
  }

  async function sendTurn(id: RequestId, params: Params<'turn.send'>): Promise<void> {
    reply(id, await host.sendTurn(params.sessionId, params.input, params.files));
  }

  async function cancelTurn(id: RequestId, params: Params<'turn.cancel'>): Promise<void> {
    await host.cancelTurn(params.sessionId);
    reply(id, { cancelled: true });
  }

  async function listModels(id: RequestId, params: Params<'model.list'>): Promise<void> {
    reply(id, await host.listModels(params.sessionId));
  }

  async function setModel(id: RequestId, params: Params<'model.set'>): Promise<void> {
    reply(id, await host.setModel(params.sessionId, params.preset, params.effort));
  }

  async function compactSession(id: RequestId, params: Params<'context.compact'>): Promise<void> {
    reply(id, await host.compactSession(params.sessionId));
  }

  async function listGrants(id: RequestId, params: Params<'grants.list'>): Promise<void> {
    reply(id, await host.listGrants(params.sessionId));
  }

  async function revokeGrant(id: RequestId, params: Params<'grants.revoke'>): Promise<void> {
    reply(id, await host.revokeGrant(params.sessionId, params.grantId));
  }

  async function undoChange(id: RequestId, params: Params<'change.undo'>): Promise<void> {
    reply(id, await host.undoChange(params.sessionId));
  }

  async function redoChange(id: RequestId, params: Params<'change.redo'>): Promise<void> {
    reply(id, await host.redoChange(params.sessionId));
  }

  async function respondApproval(id: RequestId, params: Params<'approval.respond'>): Promise<void> {
    await host.respondApproval(params.sessionId, params.callId, params.verdict);
    reply(id, { accepted: true });
  }

  async function setPlanMode(id: RequestId, params: Params<'plan.setMode'>): Promise<void> {
    await host.setPlanMode(params.sessionId, params.enabled);
    reply(id, { enabled: params.enabled });
  }

  async function respondPlan(id: RequestId, params: Params<'plan.reply'>): Promise<void> {
    await host.respondPlan(params.sessionId, params.callId, params.choice, params.reason);
    reply(id, { accepted: true });
  }

  async function readAttachment(id: RequestId, params: Params<'attachment.read'>): Promise<void> {
    reply(id, await host.readAttachment(params.id, params.maxBytes ?? null));
  }

  async function stopTask(id: RequestId, params: Params<'task.stop'>): Promise<void> {
    reply(id, { stopped: await host.stopTask(params.sessionId, params.taskId) });
  }

  async function listCronJobs(id: RequestId, params: Params<'cron.list'>): Promise<void> {
    reply(id, { jobs: await host.listCronJobs(params.sessionId) });
  }

  async function removeCronJob(id: RequestId, params: Params<'cron.remove'>): Promise<void> {
    reply(id, { removed: await host.removeCronJob(params.sessionId, params.jobId) });
  }

  async function trustStatus(id: RequestId): Promise<void> {
    reply(id, await host.trustStatus());
  }

  async function trustGrant(id: RequestId): Promise<void> {
    await host.trustGrant();
    reply(id, { granted: true });
  }

  function shutdown(id: RequestId): void {
    reply(id, { closing: true });
    stop();
  }

  /** One host update, routed to the notification that carries it. */
  function notify(update: unknown): void {
    if (isDelta(update)) {
      const parsed = deltaParamsSchema.safeParse(update);
      if (parsed.success) {
        send(serializeNotification(NOTIFICATIONS.delta, parsed.data));
        return;
      }
    }
    if (isWireEvent(update)) {
      send(serializeNotification(NOTIFICATIONS.event, update));
      return;
    }
    // Saying so beats putting an unreadable fact on the wire: the renderer would have
    // to guess, and a guess about a durable fact is the failure mode ADR-055 exists to
    // avoid. The client sees a diagnostic, not a session fact.
    send(
      serializeNotification(NOTIFICATIONS.log, {
        level: 'error',
        message: 'host produced an update the protocol cannot carry',
      }),
    );
  }

  return { closed, close: stop };
}

function isDelta(update: unknown): boolean {
  if (typeof update !== 'object' || update === null) return false;
  const type: unknown = Reflect.get(update, 'type');
  // Ephemeral stream fragments; none is a `KernelEvent` and all share the `delta`
  // notification's shape (ADR-098, ADR-108).
  return type === 'model.delta' || type === 'reasoning.delta' || type === 'tool.output.delta';
}

function describe(error: unknown): JsonRpcError {
  if (error instanceof ProtocolHostError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  const message = error instanceof Error ? error.message : String(error);
  // One line: this travels to a renderer, and a kernel stack trace is not something a
  // frame can usefully show. The full error stays on the server side.
  return { code: ERROR_CODES.internalError, message: message.split('\n')[0] ?? 'host failure' };
}
