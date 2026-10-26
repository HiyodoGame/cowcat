import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireDelta, WireEvent, WireLog } from '../src/index.js';
import { ScriptedHost, delta, event, flush, newScriptedSession, wire } from './support.js';

/**
 * ADR-059 ①: the whole round — open a session, send input, receive events, answer an
 * approval, cancel — over the in-memory transport, with no process and no terminal.
 */
test('contract: open → input → events → approval → cancel, in one pass', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  host.emit('s1', event('s1', 1, 'session.opened', { schemaVersion: 1, cowcatVersion: '0.0.0', shell: {} }));
  const { client, server } = wire(host);

  const events: WireEvent[] = [];
  const deltas: WireDelta[] = [];
  const logs: WireLog[] = [];
  client.on('event', (e) => events.push(e));
  client.on('delta', (d) => deltas.push(d));
  client.on('log', (l) => logs.push(l));

  const hello = await client.initialize();
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.serverVersion, '0.0.0-test');

  const created = await client.createSession();
  assert.equal(created.sessionId, 'session-minted');
  assert.deepEqual(await client.listSessions(), [
    { sessionId: 's1', lastSeq: 1 },
    { sessionId: 'session-minted', lastSeq: 0 },
  ]);

  // The replay arrives *after* the reply, so the client can register the session first.
  const opened = await client.openSession('s1');
  assert.deepEqual(opened, { sessionId: 's1', lastSeq: 1, replayed: 1 });
  await flush();
  assert.deepEqual(
    events.map((e) => e.type),
    ['session.opened'],
  );

  const turnId = await client.sendTurn('s1', 'hello');
  assert.equal(turnId, 'turn-1');
  assert.deepEqual(host.turns, [{ sessionId: 's1', input: 'hello' }]);

  host.emit('s1', event('s1', 2, 'turn.opened', { turnId, input: 'hello' }));
  host.emit('s1', delta(turnId, 'Hel'));
  host.emit('s1', delta(turnId, 'lo'));
  host.emit(
    's1',
    event('s1', 3, 'approval.requested', { turnId, callId: 'call_1', name: 'Bash', rule: 'default', reason: null }),
  );
  await flush();

  assert.deepEqual(
    events.map((e) => e.type),
    ['session.opened', 'turn.opened', 'approval.requested'],
  );
  assert.deepEqual(deltas.map((d) => d.text), ['Hel', 'lo']);
  assert.deepEqual(logs, [], 'nothing should be reported as un-carryable');

  await client.respondApproval('s1', 'call_1', 'always');
  assert.deepEqual(host.approvals, [{ sessionId: 's1', callId: 'call_1', verdict: 'always' }]);

  await client.cancelTurn('s1');
  assert.deepEqual(host.cancellations, ['s1']);

  await client.shutdown();
  await client.closed;
  await server.closed;
});

test('two requests in flight are correlated by id, not by order', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();

  const [turnId, sessions] = await Promise.all([client.sendTurn('s1', 'hi'), client.listSessions()]);
  assert.equal(turnId, 'turn-1');
  assert.deepEqual(sessions, [{ sessionId: 's1', lastSeq: 0 }]);
});

test('re-opening a session replaces the subscription instead of doubling it', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();

  const events: WireEvent[] = [];
  client.on('event', (e) => events.push(e));

  await client.openSession('s1');
  await client.openSession('s1');
  await flush();
  // The second open replays nothing new (the log is still empty) …
  assert.deepEqual(events, []);
  assert.equal(host.sessions.get('s1')?.listeners.size, 1, 'one listener, not two');

  host.emit('s1', event('s1', 1, 'turn.opened', { turnId: null }));
  await flush();
  assert.equal(events.length, 1, 'each update is delivered exactly once');
});

test('a session that is replaced keeps replaying its own log to a new client', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  host.emit('s1', event('s1', 1, 'session.opened', {}));
  host.emit('s1', event('s1', 2, 'turn.opened', {}));
  const { client } = wire(host);
  await client.initialize();

  const events: WireEvent[] = [];
  client.on('event', (e) => events.push(e));
  const opened = await client.openSession('s1');
  await flush();

  assert.equal(opened.replayed, 2);
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2],
  );
});

test('trust.status reports the host snapshot and trust.grant is a bare write (ADR-157)', async () => {
  const host = new ScriptedHost([]);
  host.trustSnapshot = { trusted: false, withheld: { rules: 2, instructions: 1, skills: 3, mcpServers: 1, hooks: 0 } };
  const { client } = wire(host);
  await client.initialize();

  const status = await client.trustStatus();
  assert.equal(status.trusted, false);
  assert.deepEqual(status.withheld, { rules: 2, instructions: 1, skills: 3, mcpServers: 1, hooks: 0 });

  // Grant is a write, not a state flip: the running snapshot stays untrusted — the
  // caller rebuilds the host to pick up the project layer.
  await client.trustGrant();
  assert.equal(host.trustGrants.length, 1);
  assert.equal((await client.trustStatus()).trusted, false);
});

test('accept-edits.set is a user-act toggle with the applied state echoed (ADR-159)', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host);
  await client.initialize();

  assert.equal(await client.setAcceptEdits('s1', true), true);
  assert.equal(await client.setAcceptEdits('s1', false), false);
  assert.deepEqual(host.acceptEditsToggles, [
    { sessionId: 's1', enabled: true },
    { sessionId: 's1', enabled: false },
  ]);
  // An unknown session is the host's refusal, not a silent ok.
  await assert.rejects(() => client.setAcceptEdits('nope', true));
});

test('providers.list reports the user layer; provider.set writes one entry (ADR-165)', async () => {
  const host = new ScriptedHost([]);
  host.providerRows = [
    { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', keySet: true },
    { name: 'selfhost', baseUrl: 'https://gw.local/v1', apiKeyEnv: 'GW_KEY', keySet: false },
  ];
  const { client } = wire(host);
  await client.initialize();

  const { providers } = await client.listProviders();
  assert.equal(providers.length, 2);
  assert.equal(providers[1]?.keySet, false);

  await client.setProvider('selfhost', { baseUrl: 'https://gw2.local/v1' });
  assert.deepEqual(host.writtenProviders, [{ name: 'selfhost', fields: { baseUrl: 'https://gw2.local/v1' } }]);
});
