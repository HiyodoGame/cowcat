import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stdioTransport, type Transport } from '../../src/protocol/index.js';

interface Wired {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly transport: Transport;
  readonly diagnostics: string[];
  readonly received: string[];
  readonly closedCount: () => number;
}

function wire(options: { readonly maxLineBytes?: number } = {}): Wired {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics: string[] = [];
  const received: string[] = [];
  let closed = 0;
  const transport = stdioTransport(
    { input, output },
    {
      onDiagnostic: (message) => diagnostics.push(message),
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    },
  );
  transport.onMessage((line) => received.push(line));
  transport.onClose(() => {
    closed += 1;
  });
  return { input, output, transport, diagnostics, received, closedCount: () => closed };
}

/** Let the stream callbacks run. `data` happens to be synchronous through a
 *  PassThrough, `end` is not — settling everywhere keeps these tests from depending on
 *  which of the two it is. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test('two lines in one chunk are two messages', async () => {
  const wired = wire();
  wired.input.write('{"a":1}\n{"a":2}\n');
  await settle();
  assert.deepEqual(wired.received, ['{"a":1}', '{"a":2}']);
});

test('a line split across chunks is one message', async () => {
  const wired = wire();
  wired.input.write('{"a"');
  wired.input.write(':1}');
  await settle();
  assert.deepEqual(wired.received, []);
  wired.input.write('\n');
  await settle();
  assert.deepEqual(wired.received, ['{"a":1}']);
});

test('a multi-byte character split across chunks is decoded, not mangled', async () => {
  const wired = wire();
  // The failure this guards is not hypothetical: model output is full of characters
  // that occupy more than one byte, and decoding each chunk on its own would corrupt
  // exactly those messages.
  const bytes = Buffer.from('测', 'utf8');
  assert.equal(bytes.length, 3);
  wired.input.write(bytes.subarray(0, 1));
  wired.input.write(bytes.subarray(1));
  wired.input.write('\n');
  await settle();
  assert.deepEqual(wired.received, ['测']);
});

test('CRLF is framing, not payload', async () => {
  const wired = wire();
  wired.input.write('{"a":1}\r\n');
  await settle();
  assert.deepEqual(wired.received, ['{"a":1}']);
});

test('empty lines are ignored', async () => {
  const wired = wire();
  wired.input.write('\n\n{"a":1}\n\n');
  await settle();
  assert.deepEqual(wired.received, ['{"a":1}']);
});

test('send writes one line with a newline', () => {
  const wired = wire();
  wired.output.setEncoding('utf8');
  const written: string[] = [];
  wired.output.on('data', (chunk: string) => written.push(chunk));
  wired.transport.send('{"b":2}');
  assert.deepEqual(written, ['{"b":2}\n']);
});

test('sending after close throws rather than silently dropping', () => {
  const wired = wire();
  wired.transport.close();
  assert.throws(() => {
    wired.transport.send('{"b":2}');
  }, /send after close/);
});

test('close ends the output stream and notifies once', () => {
  const wired = wire();
  wired.transport.close();
  wired.transport.close();
  assert.equal(wired.output.writableEnded, true);
  assert.equal(wired.closedCount(), 1);
});

test('stdin ending is a close, with no diagnostic', async () => {
  const wired = wire();
  wired.input.end();
  await settle();
  assert.equal(wired.closedCount(), 1);
  assert.deepEqual(wired.diagnostics, []);
});

test('a line that never ends is a broken peer, reported and closed', async () => {
  const wired = wire({ maxLineBytes: 32 });
  wired.input.write('x'.repeat(40));
  await settle();
  assert.equal(wired.closedCount(), 1);
  assert.equal(wired.diagnostics.length, 1);
  assert.match(wired.diagnostics[0] ?? '', /exceeded 32 bytes/);
  assert.deepEqual(wired.received, [], 'the oversized line is not handed over as a message');
});
