import {
  AttachmentTooLargeError,
  NoSuchSessionError,
  ProtocolHostError,
  createClient,
  createServer,
  memoryTransport,
  type AttachmentBytes,
  type AttachedSession,
  type ApprovalVerdict,
  type Defer,
  type ProtocolClient,
  type ProtocolHost,
  type ProtocolServer,
  type SessionSummary,
  type Transport,
} from '../src/index.js';

/**
 * A host made of arrays. The point of the contract tests is the wire: what a client
 * sends, what it receives back, and in what order. A real kernel behind this port
 * would add its own behaviour to every assertion, and the exit criteria already put
 * the kernel end to end in T3's spawn test and T10.
 */
export class ScriptedHost implements ProtocolHost {
  readonly serverVersion = '0.0.0-test';
  readonly sessions = new Map<string, ScriptedSession>();
  readonly turns: { readonly sessionId: string; readonly input: string }[] = [];
  readonly approvals: { readonly sessionId: string; readonly callId: string; readonly verdict: ApprovalVerdict }[] = [];
  readonly cancellations: string[] = [];
  readonly attachments = new Map<string, AttachmentBytes>();
  /** The host's own cap; a caller's `maxBytes` can be lower, never higher. */
  attachmentLimit = 1024;
  mintedId = 'session-minted';
  failure: (() => never) | null = null;
  sendTurnFailure: Error | null = null;

  constructor(seed: readonly ScriptedSession[] = []) {
    for (const session of seed) this.sessions.set(session.sessionId, session);
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return Promise.resolve([...this.sessions.values()].map((s) => ({ sessionId: s.sessionId, lastSeq: s.lastSeq })));
  }

  createSession(sessionId: string | null): Promise<SessionSummary> {
    const id = sessionId ?? this.mintedId;
    if (this.sessions.has(id)) throw new ProtocolHostError(`session already exists: ${id}`);
    const session = newScriptedSession(id);
    this.sessions.set(id, session);
    return Promise.resolve({ sessionId: id, lastSeq: session.lastSeq });
  }

  attach(sessionId: string): Promise<AttachedSession> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new NoSuchSessionError(sessionId);
    // Snapshot and subscription in one step, which is the contract `host.ts` states.
    return Promise.resolve({
      lastSeq: session.lastSeq,
      replay: [...session.updates],
      subscribe: (listener) => {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
    });
  }

  sendTurn(sessionId: string, input: string): Promise<{ turnId: string }> {
    if (this.sendTurnFailure !== null) throw this.sendTurnFailure;
    if (!this.sessions.has(sessionId)) throw new NoSuchSessionError(sessionId);
    this.turns.push({ sessionId, input });
    return Promise.resolve({ turnId: `turn-${String(this.turns.length)}` });
  }

  cancelTurn(sessionId: string): Promise<void> {
    this.cancellations.push(sessionId);
    return Promise.resolve();
  }

  respondApproval(sessionId: string, callId: string, verdict: ApprovalVerdict): Promise<void> {
    this.approvals.push({ sessionId, callId, verdict });
    return Promise.resolve();
  }

  readAttachment(id: string, maxBytes: number | null): Promise<AttachmentBytes> {
    if (this.failure !== null) this.failure();
    const attachment = this.attachments.get(id);
    if (attachment === undefined) throw new ProtocolHostError(`no such attachment: ${id}`);
    const limit = Math.min(maxBytes ?? this.attachmentLimit, this.attachmentLimit);
    if (attachment.byteLength > limit) throw new AttachmentTooLargeError(id, attachment.byteLength, limit);
    return Promise.resolve(attachment);
  }

  /** Push a durable fact or a streamed delta to whoever attached this session. */
  emit(sessionId: string, update: unknown): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no such session: ${sessionId}`);
    session.updates.push(update);
    session.lastSeq += 1;
    for (const listener of session.listeners) listener(update);
  }
}

export interface ScriptedSession {
  readonly sessionId: string;
  readonly updates: unknown[];
  readonly listeners: Set<(update: unknown) => void>;
  lastSeq: number;
}

export function newScriptedSession(sessionId: string): ScriptedSession {
  return { sessionId, updates: [], listeners: new Set(), lastSeq: 0 };
}

/** An event as the kernel writes them: envelope plus body, body opaque here. */
export function event(sessionId: string, seq: number, type: string, body: Record<string, unknown> = {}): unknown {
  return { seq, ts: 1_700_000_000_000 + seq, sessionId, turnId: body['turnId'] ?? null, type, ...body };
}

export function delta(turnId: string, text: string): unknown {
  return { type: 'model.delta', turnId, text };
}

export interface Wiring {
  readonly host: ScriptedHost;
  readonly clientTransport: Transport;
  readonly serverTransport: Transport;
  readonly server: ProtocolServer;
  readonly client: ProtocolClient;
}

export function wire(host: ScriptedHost, protocolVersions: { readonly client?: number; readonly server?: number } = {}): Wiring {
  const pair = memoryTransport();
  const server = createServer({
    host,
    transport: pair.server,
    ...(protocolVersions.server === undefined ? {} : { protocolVersion: protocolVersions.server }),
  });
  const client = createClient({
    transport: pair.client,
    ...(protocolVersions.client === undefined ? {} : { protocolVersion: protocolVersions.client }),
  });
  return { host, clientTransport: pair.client, serverTransport: pair.server, server, client };
}

/** Manually driven delivery, for assertions about ordering rather than about results. */
export function manualDefer(): { readonly defer: Defer; drain(): void; pending(): number } {
  const tasks: (() => void)[] = [];
  return {
    defer: (task) => tasks.push(task),
    drain(): void {
      // A drain may enqueue more work (a reply that is itself a send); keep going
      // until the queue is empty, which is what a real event loop would do.
      while (tasks.length > 0) {
        const task = tasks.shift();
        task?.();
      }
    },
    pending: () => tasks.length,
  };
}

/** Let the transport's deferred deliveries run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
