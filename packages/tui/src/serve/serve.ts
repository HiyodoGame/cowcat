import type { Readable, Writable } from 'node:stream';
import { createServer, type ProtocolHost } from '../protocol/index.js';
import { stdioTransport, type StdioTransportOptions } from '../protocol/stdio.js';

/** Where the stop signals come from. Injectable so the lifecycle is testable off-Windows. */
export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): () => void;
}

export const SERVE_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

const processSignals: SignalSource = {
  on(signal, handler) {
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
};

export interface ServeOptions {
  /**
   * Who answers. The composition root implements this over the kernel; until it
   * exists, `refusingHost()` fills the slot and refuses with a reason.
   */
  readonly host: ProtocolHost;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly diagnostics?: (message: string) => void;
  readonly signals?: SignalSource;
  readonly protocolVersion?: number;
  readonly maxLineBytes?: number;
}

/**
 * `cowcat serve`: the protocol on stdio, plus the process lifecycle around it (ADR-055,
 * ADR-060; T3).
 *
 * It returns the exit code rather than calling `process.exit()`: the one caller that
 * cares is the process entry, and a function that exits the process cannot be tested
 * in-process. Clean exits are 0 by construction — a refusal, a version mismatch and a
 * stdin EOF are all normal ends of a `serve`, and the client already learned what
 * happened from the protocol.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics =
    options.diagnostics ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
  const signals = options.signals ?? processSignals;

  const transportOptions: StdioTransportOptions = {
    onDiagnostic: diagnostics,
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
  };
  const transport = stdioTransport({ input, output }, transportOptions);
  const server = createServer({
    host: options.host,
    transport,
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
  });

  // A server that decides to stop (`shutdown`, or a refused handshake) must take the
  // process with it; otherwise `cowcat serve` would look like it exited while still
  // holding the session lock.
  const detach = SERVE_SIGNALS.map((signal) =>
    signals.on(signal, () => {
      diagnostics(`received ${signal}; closing`);
      server.close();
    }),
  );

  await server.closed;
  for (const off of detach) off();

  // The server can close while stdin is still open (the `shutdown` method). A process
  // that keeps a referenced stdin alive would never exit, and a `serve` that hangs is
  // worse than one that errors.
  input.pause();
  const unrefable = input as Readable & { unref?: () => void };
  unrefable.unref?.();

  return 0;
}
