import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, replay, runTurn, type ToolPort } from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

/**
 * ADR-159: accept-edits mode pre-answers Write/Edit asks for the session — and nothing
 * else. The gates ABOVE it (deny, plan mode, read-before-write) keep their priority, no
 * standing grant is created, and replay folds the switch from the log.
 */

const writeProbe: ToolPort = tool({ name: 'Write', description: 'write file', risk: 'write' }, () => ({
  ok: true,
  output: 'written',
}));
const editProbe: ToolPort = tool({ name: 'Edit', description: 'edit file', risk: 'write' }, () => ({
  ok: true,
  output: 'edited',
}));
// Bash is a "write"-risk tool by risk class; the mode must key on tool NAMES.
const bashProbe: ToolPort = tool({ name: 'Bash', description: 'shell', risk: 'write' }, () => ({
  ok: true,
  output: 'ran',
}));

function call(callId: string, name: string) {
  return { type: 'tool_call' as const, call: { callId, name, input: {} } };
}

async function withMode(store: MemoryEventStore, sessionId: string, enabled: boolean) {
  const session = await Session.create(sessionDeps(store), sessionId);
  await session.emit({ type: 'accept-edits.mode-changed', turnId: null, enabled, by: 'user' });
  return session;
}

test('accept-edits pre-answers Write and Edit asks; no question, no grant', async () => {
  const store = new MemoryEventStore();
  const session = await withMode(store, 'sess_ae_on', true);
  const model = new ScriptedModel([
    [call('c1', 'Write'), call('c2', 'Edit')],
    [{ type: 'text', text: 'done' }],
  ]);
  await runTurn(
    turnDeps(session, model, { tools: new Map([[writeProbe.spec.name, writeProbe], [editProbe.spec.name, editProbe]]), rules: [] }),
    'go',
    new AbortController().signal,
  );

  assert.equal(store.events.filter((e) => e.type === 'approval.requested').length, 0, 'nothing asked');
  const answered = store.events.filter((e) => e.type === 'approval.answered');
  assert.ok(answered.every((e) => e.verdict === 'once' && e.by === 'policy'));
  assert.equal(answered.length, 2);
  // The switch is the whole permission: no always/session answer, so no grant to revoke.
  assert.equal(replay('sess_ae_on', store.events).grants.length, 0);
  for (const name of ['written', 'edited']) {
    assert.ok(store.events.some((e) => e.type === 'tool.finished' && e.output.includes(name)));
  }
});

test('Bash never rides the edits switch: it still asks', async () => {
  const store = new MemoryEventStore();
  const session = await withMode(store, 'sess_ae_bash', true);
  const model = new ScriptedModel([[call('c1', 'Bash')], [{ type: 'text', text: 'done' }]]);
  await runTurn(turnDeps(session, model, { tools: new Map([[bashProbe.spec.name, bashProbe]]), rules: [] }), 'go', new AbortController().signal);
  const asked = store.events.filter((e) => e.type === 'approval.requested');
  assert.equal(asked.length, 1, 'the shell still asks');
  assert.ok(asked[0]?.type === 'approval.requested' && asked[0].name === 'Bash');
  assert.ok(store.events.some((e) => e.type === 'tool.finished' && e.output.includes('ran')));
});

test('an explicit deny beats the mode — pre-answering is not a bypass', async () => {
  const store = new MemoryEventStore();
  const session = await withMode(store, 'sess_ae_deny', true);
  const denyRule = { name: 'no-writes', when: { tool: 'Write' }, verdict: 'deny' as const, reason: 'config says no' };
  const model = new ScriptedModel([[call('c1', 'Write')], [{ type: 'text', text: 'done' }]]);
  await runTurn(turnDeps(session, model, { tools: new Map([[writeProbe.spec.name, writeProbe]]), rules: [denyRule] }), 'go', new AbortController().signal);
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.match(finished.output, /denied by no-writes/);
  assert.equal(store.events.filter((e) => e.type === 'approval.answered').length, 0);
});

test('plan mode still refuses writes under the edits switch', async () => {
  const store = new MemoryEventStore();
  const session = await withMode(store, 'sess_ae_plan', true);
  await session.emit({ type: 'plan.mode-changed', turnId: null, enabled: true, by: 'user' });
  const model = new ScriptedModel([[call('c1', 'Write')], [{ type: 'text', text: 'done' }]]);
  await runTurn(turnDeps(session, model, { tools: new Map([[writeProbe.spec.name, writeProbe]]), rules: [] }), 'go', new AbortController().signal);
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.match(finished.output, /plan mode/);
});

test('turning the mode off restores the question', async () => {
  const store = new MemoryEventStore();
  const session = await withMode(store, 'sess_ae_off', false);
  const model = new ScriptedModel([[call('c1', 'Write')], [{ type: 'text', text: 'done' }]]);
  await runTurn(turnDeps(session, model, { tools: new Map([[writeProbe.spec.name, writeProbe]]), rules: [] }), 'go', new AbortController().signal);
  assert.equal(store.events.filter((e) => e.type === 'approval.requested').length, 1);
  assert.equal(replay('sess_ae_off', store.events).acceptEdits, false);
});

test('replay folds the switch exactly as the live session held it', async () => {
  const store = new MemoryEventStore();
  const session = await withMode(store, 'sess_ae_replay', true);
  await session.emit({ type: 'accept-edits.mode-changed', turnId: null, enabled: false, by: 'user' });
  await session.emit({ type: 'accept-edits.mode-changed', turnId: null, enabled: true, by: 'user' });
  assert.equal(replay('sess_ae_replay', store.events).acceptEdits, true);
});
