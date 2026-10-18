/**
 * Framing is the transport's problem, not the protocol's (ADR-055). The protocol hands
 * over one complete JSON object per line and does not know whether those lines go to a
 * pipe, a socket, or a pair of queues in this process.
 */
export interface Transport {
  /** One complete JSON line, no trailing newline (the transport decides how to frame). */
  send(line: string): void;
  onMessage(handler: (line: string) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}

/** How a transport defers delivery. Injectable so tests can drive it by hand. */
export type Defer = (task: () => void) => void;

export interface MemoryTransportPair {
  readonly client: Transport;
  readonly server: Transport;
}

/**
 * The in-memory transport: what ADR-059 ① puts between the `serve` handler and a test
 * client, and what a single-process mode would use later.
 *
 * Delivery is deferred rather than synchronous, because stdio is: a handler that
 * re-enters mid-send would pass a test that the real transport then fails. It is also
 * why close is queued like everything else — a `send` followed by `close` must deliver
 * the message before the close, and that ordering is exactly what the handshake
 * failure path relies on (a version mismatch answers, *then* closes).
 */
export function memoryTransport(options: { readonly defer?: Defer } = {}): MemoryTransportPair {
  const defer = options.defer ?? ((task: () => void) => {
    queueMicrotask(task);
  });
  const messageHandlers = { client: new Set<(line: string) => void>(), server: new Set<(line: string) => void>() };
  const closeHandlers = { client: new Set<() => void>(), server: new Set<() => void>() };
  const open = { client: true, server: true };
  const notified = { client: false, server: false };

  // Closing one end of a pipe ends the connection for both: a server that exits closes
  // the client's read side, which is how `serve`'s lifecycle reaches the TUI. Notifying
  // only the closing side would make a server-initiated shutdown invisible (the very
  // case the handshake-failure path depends on).
  const notifyClose = (side: 'client' | 'server'): void => {
    if (notified[side]) return;
    notified[side] = true;
    defer(() => {
      for (const handler of closeHandlers[side]) handler();
    });
  };

  const endpoint = (self: 'client' | 'server'): Transport => {
    const peer = self === 'client' ? 'server' : 'client';
    return {
      send(line: string): void {
        if (!open[self]) throw new Error(`send after close (${self})`);
        defer(() => {
          // The peer may have closed in the meantime; a closed endpoint delivers
          // nothing, which is what a broken pipe does.
          if (!open[peer]) return;
          for (const handler of messageHandlers[peer]) handler(line);
        });
      },
      onMessage(handler: (line: string) => void): () => void {
        messageHandlers[self].add(handler);
        return () => messageHandlers[self].delete(handler);
      },
      onClose(handler: () => void): () => void {
        closeHandlers[self].add(handler);
        return () => closeHandlers[self].delete(handler);
      },
      close(): void {
        if (!open[self]) return;
        open[self] = false;
        notifyClose(self);
        notifyClose(peer);
      },
    };
  };

  return { client: endpoint('client'), server: endpoint('server') };
}
