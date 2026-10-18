import type { Readable, Writable } from 'node:stream';
import type { Transport } from './transport.js';

/** A single line larger than this is a broken peer, not a large request. */
export const STDIO_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface StdioTransportOptions {
  readonly maxLineBytes?: number;
  /**
   * Where framing problems go. This layer sits *below* the protocol, so it cannot
   * answer with a JSON-RPC error: it may not have a parseable request to answer, and
   * inventing one would be the protocol layer's job done badly.
   */
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * The stdio transport: newline-delimited JSON over a pipe (ADR-055 — no
 * `Content-Length` framing, because our payloads contain no bare newlines and a
 * second parser is a second thing that has to be right).
 *
 * Two details are load-bearing rather than incidental:
 *
 *  - the input is switched to `utf8` decoding, so a multi-byte character split across
 *    two chunks is decoded correctly. Doing `chunk.toString()` per chunk would corrupt
 *    exactly the messages this product is full of (model output in Chinese, box
 *    drawing, emoji).
 *  - closing one end notifies ours. `serve` decides to stop, and the process has to
 *    learn that its stdin is never going to speak again.
 */
export function stdioTransport(
  streams: { readonly input: Readable; readonly output: Writable },
  options: StdioTransportOptions = {},
): Transport {
  const { input, output } = streams;
  const maxLineBytes = options.maxLineBytes ?? STDIO_MAX_LINE_BYTES;
  const messageHandlers = new Set<(line: string) => void>();
  const closeHandlers = new Set<() => void>();
  let buffer = '';
  let stopped = false;

  const stop = (reason: string | null, endOutput: boolean): void => {
    if (stopped) return;
    stopped = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onEnd);
    if (reason !== null) options.onDiagnostic?.(reason);
    if (endOutput) output.end();
    for (const handler of closeHandlers) handler();
  };

  const onData = (chunk: string): void => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      // A peer that writes CRLF (a Windows pipe, or a client that thinks in lines)
      // is not an error; the carriage return is framing, not payload.
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.length > 0) for (const handler of messageHandlers) handler(line);
    }
    if (buffer.length > maxLineBytes) {
      stop(`stdin exceeded ${String(maxLineBytes)} bytes without a newline; closing`, true);
    }
  };

  const onEnd = (): void => {
    stop(null, true);
  };

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onEnd);

  return {
    send(line: string): void {
      if (stopped) throw new Error('send after close (stdio)');
      // Backpressure is deliberately not handled: these are control messages and
      // streamed deltas between two processes on one machine, and a client that stops
      // reading its own pipe is the client's problem, not a reason to complicate the
      // transport.
      output.write(`${line}\n`);
    },
    onMessage(handler: (line: string) => void): () => void {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler: () => void): () => void {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close(): void {
      stop(null, true);
    },
  };
}
