import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryTransport } from '../src/index.js';
import { manualDefer } from './support.js';

test('a message sent before close is delivered before the close', () => {
  const manual = manualDefer();
  const pair = memoryTransport({ defer: manual.defer });
  const seen: string[] = [];
  pair.client.onMessage((line) => seen.push(`message:${line}`));
  pair.client.onClose(() => seen.push('closed'));

  pair.server.send('one');
  pair.server.close();
  manual.drain();

  // This ordering is what the handshake-failure path depends on: the refusal has to
  // reach the client before the connection ends, or a version mismatch looks like a
  // crash (see server.ts's initialize).
  assert.deepEqual(seen, ['message:one', 'closed']);
});

test('closing one end ends the connection for both', () => {
  const manual = manualDefer();
  const pair = memoryTransport({ defer: manual.defer });
  let serverSawClose = false;
  pair.server.onClose(() => {
    serverSawClose = true;
  });

  pair.client.close();
  manual.drain();
  assert.equal(serverSawClose, true, 'a client that goes away must not leave the server attached');
});

test('sending after close throws rather than silently dropping', () => {
  const manual = manualDefer();
  const pair = memoryTransport({ defer: manual.defer });
  const seen: string[] = [];
  pair.client.onMessage((line) => seen.push(line));

  pair.server.close();
  assert.throws(() => {
    pair.server.send('late');
  }, /send after close/);

  // A message queued before the peer closed is dropped, which is what a broken pipe
  // does: the endpoint is gone, and pretending otherwise would hide the failure.
  const other = memoryTransport({ defer: manual.defer });
  other.client.onMessage((line) => seen.push(line));
  other.server.send('queued');
  other.client.close();
  manual.drain();
  assert.deepEqual(seen, []);
});

test('delivery is deferred, so a handler never runs inside send', async () => {
  const pair = memoryTransport();
  const order: string[] = [];
  pair.server.onMessage(() => order.push('delivered'));
  pair.client.send('x');
  order.push('after send');
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(order, ['after send', 'delivered']);
});
