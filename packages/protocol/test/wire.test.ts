import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deltaParamsSchema,
  eventParamsSchema,
  isWireEvent,
  parseIncoming,
  settle,
  type WireEvent,
  type WireLog,
} from '../src/index.js';
import { ScriptedHost, delta, event, flush, newScriptedSession, wire } from './support.js';

/**
 * What the protocol promises about *additive* change.
 *
 * The event body is the kernel's, and the kernel grows it (T5 adds `attachments` to
 * `tool.finished`). If the protocol validated the body, every such change would break
 * the frontend until the protocol was updated in lockstep — which is the coupling the
 * headless protocol exists to remove. So the envelope is strict and the body is not,
 * and these tests are what keeps that decision honest.
 */
test('an event carrying fields this version does not know survives the trip', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();
  await client.openSession('s1');

  const events: WireEvent[] = [];
  client.on('event', (e) => events.push(e));

  const future = {
    ...(event('s1', 1, 'tool.finished', { callId: 'call_1', ok: true }) as Record<string, unknown>),
    attachments: [{ type: 'image', mediaType: 'image/png', bytes: 4096 }],
  };
  host.emit('s1', future);
  await flush();

  assert.equal(events.length, 1);
  assert.deepEqual(Reflect.get(events[0] ?? {}, 'attachments'), [
    { type: 'image', mediaType: 'image/png', bytes: 4096 },
  ]);
});

test('an event of a type this version does not know is delivered, not rejected', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();
  await client.openSession('s1');

  const events: WireEvent[] = [];
  const logs: WireLog[] = [];
  client.on('event', (e) => events.push(e));
  client.on('log', (l) => logs.push(l));

  host.emit('s1', event('s1', 1, 'something.invented.later', { detail: 42 }));
  await flush();

  assert.deepEqual(
    events.map((e) => e.type),
    ['something.invented.later'],
    'a newer kernel must not turn this frontend into a dead one',
  );
  assert.deepEqual(logs, []);
});

test('an update with no envelope is reported as a diagnostic, never as a fact', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();
  await client.openSession('s1');

  const events: WireEvent[] = [];
  const logs: WireLog[] = [];
  client.on('event', (e) => events.push(e));
  client.on('log', (l) => logs.push(l));

  host.emit('s1', { type: 'turn.opened' }); // no seq / ts / sessionId
  await flush();

  assert.deepEqual(events, [], 'a durable fact the protocol cannot describe is not shipped');
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, 'error');
});

test('the envelope schema is strict about the fields every consumer reads', () => {
  assert.equal(isWireEvent(event('s1', 1, 'turn.opened')), true);
  assert.equal(isWireEvent({ type: 'turn.opened', ts: 1, sessionId: 's1', turnId: null }), false, 'seq is required');
  assert.equal(isWireEvent({ seq: 1, ts: 1, sessionId: 's1', turnId: 3, type: 'turn.opened' }), false, 'turnId is nullable, not free-form');
  assert.equal(eventParamsSchema.safeParse({ seq: -1, ts: 1, sessionId: 's1', turnId: null, type: 'x' }).success, false);
});

test('a delta keeps its own shape and tolerates later fields', async () => {
  assert.equal(deltaParamsSchema.safeParse({ type: 'model.delta', turnId: 't1', text: 'x' }).success, true);
  assert.equal(deltaParamsSchema.safeParse({ type: 'model.delta', turnId: 't1' }).success, false, 'text is required');
  assert.equal(deltaParamsSchema.safeParse({ type: 'model.delta', turnId: 't1', text: 'x', tokens: 3 }).success, true);
  assert.equal(deltaParamsSchema.safeParse({ type: 'other.delta', turnId: 't1', text: 'x' }).success, false);

  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();
  await client.openSession('s1');
  const deltas: unknown[] = [];
  client.on('delta', (d) => deltas.push(d));
  host.emit('s1', { ...(delta('t1', 'x') as Record<string, unknown>), tokens: 3 });
  await flush();
  assert.equal(deltas.length, 1);
});

test('parseIncoming separates requests, notifications and junk', () => {
  assert.equal(parseIncoming('{"jsonrpc":"2.0","id":1,"method":"session.list"}').kind, 'request');
  assert.equal(parseIncoming('{"jsonrpc":"2.0","method":"session.list"}').kind, 'notification');
  assert.equal(parseIncoming('{"jsonrpc":"1.0","id":1,"method":"session.list"}').kind, 'invalid');
  assert.equal(parseIncoming('{"id":1}').kind, 'invalid');
  const missing = parseIncoming('{"jsonrpc":"2.0","method":"session.list"}');
  assert.equal(missing.kind === 'notification' ? missing.notification.params : 'unset', undefined);
});

test('settle reads a wire response as one of two outcomes', () => {
  assert.deepEqual(settle({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { ok: true, result: { ok: true } });
  const failed = settle({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } });
  assert.equal(failed.ok, false);
});
