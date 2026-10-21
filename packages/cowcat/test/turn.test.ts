import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  replay,
  runTurn,
  type ActionRequest,
  type ApprovalVerdict,
  type KernelEvent,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

const readTool: ToolPort = tool({ name: 'read_file', description: 'read', risk: 'read' }, () => ({
  ok: true,
  output: 'file contents',
}));

const writeTool: ToolPort = tool({ name: 'write_file', description: 'write', risk: 'write' }, () => ({
  ok: true,
  output: 'written',
}));

async function setup(
  model: ScriptedModel,
  tools: ToolPort[],
  approve: (r: ActionRequest) => Promise<ApprovalVerdict> = () => Promise.resolve('once'),
) {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_1');
  const deps = turnDeps(session, model, {
    tools: new Map(tools.map((t) => [t.spec.name, t])),
    approve: (r: ActionRequest) => approve(r),
  });
  return { store, session, deps };
}

const types = (events: readonly KernelEvent[]) => events.map((e) => e.type);

test('a plain answer completes the turn in one model call', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'hello' }]]);
  const { store, session, deps } = await setup(model, []);
  const outcome = await runTurn(deps, 'hi', new AbortController().signal);

  assert.deepEqual(outcome, { turnId: 'turn_1', state: 'completed', reason: null, partial: false, notes: [] });
  assert.equal(session.state.turn?.state, 'completed');
  assert.deepEqual(session.state.messages, [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello', toolCalls: [], reasoning: [] },
  ]);
  assert.deepEqual(types(store.events), [
    'session.opened',
    'turn.opened',
    'turn.transitioned', // idle -> requesting
    'turn.transitioned', // requesting -> streaming
    'model.message',
    'turn.transitioned', // streaming -> finishing
    'turn.transitioned', // finishing -> completed
  ]);
});

test('streamed text is shown live but never written to the log', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }]]);
  const { store, session, deps } = await setup(model, []);
  const deltas: string[] = [];
  session.subscribe((u) => {
    if (u.type === 'model.delta') deltas.push(u.text);
  });
  await runTurn(deps, 'hi', new AbortController().signal);

  assert.deepEqual(deltas, ['he', 'llo']);
  assert.equal(store.events.some((e) => (e.type as string) === 'model.delta'), false);
  assert.equal(store.events.find((e) => e.type === 'model.message')?.type, 'model.message');
});

test('streamed reasoning is shown live and never written to the log', async () => {
  const model = new ScriptedModel([
    [
      { type: 'reasoning.delta', text: '先看' },
      { type: 'reasoning.delta', text: '调用点' },
      { type: 'reasoning', block: { type: 'thinking', text: '先看调用点', signature: 's' } },
      { type: 'text', text: '好了' },
    ],
  ]);
  const { store, session, deps } = await setup(model, []);
  const deltas: string[] = [];
  session.subscribe((u) => {
    if (u.type === 'reasoning.delta') deltas.push(u.text);
  });
  await runTurn(deps, 'hi', new AbortController().signal);

  assert.deepEqual(deltas, ['先看', '调用点']);
  assert.equal(store.events.some((e) => (e.type as string) === 'reasoning.delta'), false);
  const message = store.events.find((e) => e.type === 'model.message');
  assert.ok(message !== undefined);
  assert.deepEqual(message.reasoning, [{ type: 'thinking', text: '先看调用点', signature: 's' }]);
});

test('a read tool runs without asking and its result reaches the next model call', async () => {
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'read_file', input: { path: 'a' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const { session, deps } = await setup(model, [readTool]);
  const outcome = await runTurn(deps, 'read it', new AbortController().signal);

  assert.equal(outcome.state, 'completed');
  assert.deepEqual(model.requests[1]?.messages.at(-1), {
    role: 'tool',
    callId: 'c1',
    ok: true,
    output: 'file contents',
    attachments: [],
  });
  assert.equal(session.state.messages.length, 4);
});

test('a write tool is asked about, and a rejection is reported to the model instead of executed', async () => {
  const asked: string[] = [];
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'write_file', input: {} } }],
    [{ type: 'text', text: 'ok, skipping' }],
  ]);
  const { session, deps } = await setup(model, [writeTool], async (r) => {
    asked.push(r.name);
    return 'reject';
  });
  await runTurn(deps, 'write it', new AbortController().signal);

  assert.deepEqual(asked, ['write_file']);
  const toolMsg = session.state.messages.find((m) => m.role === 'tool');
  assert.deepEqual(toolMsg, { role: 'tool', callId: 'c1', ok: false, output: 'rejected by user', attachments: [] });
});

test('a denied action never reaches the tool', async () => {
  let ran = false;
  const guarded: ToolPort = tool({ name: 'rm_all', description: 'x', risk: 'exec' }, () => {
    ran = true;
    return { ok: true, output: '' };
  });
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'rm_all', input: {} } }],
    [{ type: 'text', text: 'ok' }],
  ]);
  const { session } = await setup(model, [guarded]);
  // Built here rather than mutated onto the returned deps: TurnDeps is readonly by
  // design, and a test that needs different rules should say so where it constructs
  // them.
  const deps = turnDeps(session, model, {
    tools: new Map([['rm_all', guarded]]),
    rules: [{ name: 'no-rm', when: { tool: 'rm_all' }, verdict: 'deny', reason: 'never' }],
  });
  await runTurn(deps, 'go', new AbortController().signal);

  assert.equal(ran, false);
});

test('a tool that throws becomes a failed tool result, not a failed turn', async () => {
  const boom: ToolPort = tool({ name: 'read_file', description: 'x', risk: 'read' }, () => {
    throw new Error('disk on fire');
  });
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'read_file', input: {} } }],
    [{ type: 'text', text: 'recovered' }],
  ]);
  const { session, deps } = await setup(model, [boom]);
  const outcome = await runTurn(deps, 'x', new AbortController().signal);

  assert.equal(outcome.state, 'completed');
  assert.deepEqual(session.state.messages.find((m) => m.role === 'tool'), {
    role: 'tool',
    callId: 'c1',
    ok: false,
    output: 'disk on fire',
    attachments: [],
  });
});

test('a model error fails the turn with its reason, and the log says so', async () => {
  const model = new ScriptedModel([new Error('upstream 503')]);
  const { store, session, deps } = await setup(model, []);
  const outcome = await runTurn(deps, 'hi', new AbortController().signal);

  assert.deepEqual(outcome, { turnId: 'turn_1', state: 'failed', reason: 'upstream 503', partial: false, notes: [] });
  assert.equal(session.state.turn?.state, 'failed');
  const last = store.events.at(-1);
  assert.equal(last?.type, 'turn.transitioned');
});

test('aborting before the call cancels without calling the model', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'never' }]]);
  const { session, deps } = await setup(model, []);
  const ctrl = new AbortController();
  ctrl.abort();
  const outcome = await runTurn(deps, 'hi', ctrl.signal);

  assert.equal(outcome.state, 'cancelled');
  assert.equal(model.requests.length, 0);
  assert.equal(session.state.turn?.state, 'cancelled');
});

test('replaying the log reproduces the live session state exactly', async () => {
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'read_file', input: {} } }],
    [{ type: 'text', text: 'final' }],
  ]);
  const { store, session, deps } = await setup(model, [readTool]);
  await runTurn(deps, 'go', new AbortController().signal);

  assert.deepEqual(replay('sess_1', store.events), session.state);
});

test('a session reopened from the store continues where it stopped', async () => {
  const store = new MemoryEventStore();
  const deps = sessionDeps(store);
  const first = await Session.create(deps, 'sess_2');
  await runTurn(
    turnDeps(first, new ScriptedModel([[{ type: 'text', text: 'one' }]])),
    'first',
    new AbortController().signal,
  );

  const reopened = await Session.open(deps, 'sess_2');
  assert.equal(reopened.state.messages.length, 2);
  assert.equal(reopened.state.lastSeq, first.state.lastSeq);
  assert.equal(reopened.state.turn?.state, 'completed');
});
