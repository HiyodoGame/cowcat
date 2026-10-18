import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ERROR_CODES, parseResponse, type JsonRpcError, type JsonRpcResponse } from '../src/index.js';
import { NOT_WIRED, refusingHost } from '../src/index.js';
import { serve, type SignalSource } from '../src/index.js';

interface Harness {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly diagnostics: string[];
  readonly responses: JsonRpcResponse[];
  readonly done: Promise<number>;
  send(request: object): void;
  fire(signal: NodeJS.Signals): void;
  readonly activeSignals: () => number;
}

function start(options: { readonly protocolVersion?: number } = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics: string[] = [];
  const responses: JsonRpcResponse[] = [];
  const handlers = new Map<NodeJS.Signals, Set<() => void>>();
  const signals: SignalSource = {
    on(signal, handler) {
      const set = handlers.get(signal) ?? new Set<() => void>();
      set.add(handler);
      handlers.set(signal, set);
      return () => set.delete(handler);
    },
  };

  output.setEncoding('utf8');
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const parsed = parseResponse(line);
      if (parsed !== null) responses.push(parsed);
    }
  });

  const done = serve({
    host: refusingHost(),
    input,
    output,
    diagnostics: (message) => diagnostics.push(message),
    signals,
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
  });

  return {
    input,
    output,
    diagnostics,
    responses,
    done,
    send: (request) => {
      input.write(`${JSON.stringify(request)}\n`);
    },
    fire: (signal) => {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
    activeSignals: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
  };
}

function errorOf(response: JsonRpcResponse | undefined): JsonRpcError | null {
  return response !== undefined && 'error' in response ? response.error : null;
}

function resultOf(response: JsonRpcResponse | undefined): unknown {
  return response !== undefined && 'result' in response ? response.result : null;
}

/** Let the stream callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const HANDSHAKE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };

test('handshake, then shutdown: the process is done and its output is closed', async () => {
  const harness = start();
  harness.send(HANDSHAKE);
  await settle();
  assert.deepEqual(resultOf(harness.responses[0]), { protocolVersion: 1, serverVersion: '0.0.0+unwired' });

  harness.send({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} });
  assert.equal(await harness.done, 0);
  assert.equal(harness.output.writableEnded, true);
});

test('the placeholder host refuses with a reason, and a refusal is not a reason to stop', async () => {
  const harness = start();
  harness.send(HANDSHAKE);
  await settle();
  harness.send({ jsonrpc: '2.0', id: 2, method: 'session.list', params: {} });
  await settle();

  const error = errorOf(harness.responses[1]);
  assert.equal(error?.code, ERROR_CODES.hostRefused);
  // Naming what is missing is the whole point of a placeholder: a client that reads
  // "no sessions" would be reading an empty success as a fact.
  assert.equal(error.message, NOT_WIRED);
  assert.equal(harness.output.writableEnded, false);
});

test('stdin ending is a clean exit', async () => {
  const harness = start();
  harness.input.end();
  assert.equal(await harness.done, 0);
  assert.equal(harness.output.writableEnded, true);
});

test('a stop signal closes the server and detaches its handlers', async () => {
  const harness = start();
  assert.equal(harness.activeSignals(), 2, 'SIGINT and SIGTERM are both handled');
  harness.fire('SIGINT');
  assert.equal(await harness.done, 0);
  assert.equal(harness.activeSignals(), 0, 'a serve that returns must not leave process-wide handlers behind');
  assert.match(harness.diagnostics.join('\n'), /received SIGINT/);
});

test('a refused handshake still exits cleanly, after the refusal is delivered', async () => {
  const harness = start();
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } });
  assert.equal(await harness.done, 0);
  assert.equal(errorOf(harness.responses[0])?.code, ERROR_CODES.versionMismatch);
});
