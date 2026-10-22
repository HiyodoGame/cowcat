import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  replay,
  runTurn,
  type KernelEvent,
  type ModelChunk,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

/**
 * ADR-120: consecutive identical tool calls (same name, same normalized input, across
 * rounds too) earn a deterministic reminder next to the repeated call's result. The
 * reminder is a log fact — replay reproduces it without re-deriving anything.
 */

const SESSION = 'sess_repeat';

const probe: ToolPort = tool({ name: 'Probe', description: 'probe', risk: 'read' }, (input) => ({
  ok: true,
  output: `probed ${JSON.stringify(input)}`,
}));

function call(callId: string, input: unknown) {
  return { type: 'tool_call' as const, call: { callId, name: 'Probe', input } };
}

async function runRoundTrip(script: readonly (readonly ModelChunk[])[]) {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), SESSION);
  const deps = turnDeps(session, new ScriptedModel(script), {
    tools: new Map([[probe.spec.name, probe]]),
  });
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  return { store, session, outcome };
}

const reminders = (events: readonly KernelEvent[]) =>
  events.filter(
    (event): event is Extract<KernelEvent, { readonly type: 'tool.repeat-detected' }> =>
      event.type === 'tool.repeat-detected',
  );

test('a second consecutive identical call earns a reminder with count 2', async () => {
  const same = { path: '/repo/a.txt' };
  const { store, session, outcome } = await runRoundTrip([
    [call('c1', same)],
    [call('c2', same)],
    [{ type: 'text', text: 'done' }],
  ]);

  assert.equal(outcome.state, 'completed');
  const events = reminders(store.events);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event !== undefined);
  assert.equal(event.count, 2);
  assert.equal(event.name, 'Probe');
  assert.match(event.text, /consecutive identical call #2/);

  // The reminder is a user message right after the repeated call's result.
  const messages = session.state.messages;
  const resultIndex = messages.findIndex((message) => message.role === 'tool' && message.callId === 'c2');
  const next = messages[resultIndex + 1];
  assert.ok(next?.role === 'user');
  assert.equal(next.text, event.text);

  // And replay reproduces it from the log alone.
  const replayed = replay(SESSION, store.events);
  assert.deepEqual(replayed.messages, session.state.messages);
});

test('the streak counts on: a third identical call reports count 3', async () => {
  const same = { command: 'build' };
  const { store } = await runRoundTrip([
    [call('c1', same)],
    [call('c2', same)],
    [call('c3', same)],
    [{ type: 'text', text: 'done' }],
  ]);

  assert.deepEqual(
    reminders(store.events).map((event) => event.count),
    [2, 3],
  );
});

test('different arguments reset the streak; a later repeat starts counting from 2 again', async () => {
  const same = { path: '/repo/a.txt' };
  const { store } = await runRoundTrip([
    [call('c1', same)],
    [call('c2', { path: '/repo/b.txt' })],
    [call('c3', same)],
    [{ type: 'text', text: 'done' }],
  ]);

  assert.equal(reminders(store.events).length, 0, 'no two consecutive calls were identical');
});

test('two identical calls in the same round count too: the second is already a repeat', async () => {
  const same = { path: '/repo/a.txt' };
  const { store } = await runRoundTrip([
    [call('c1', same), call('c2', same)],
    [{ type: 'text', text: 'done' }],
  ]);

  const events = reminders(store.events);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.count, 2);
});

test('argument order matters: same fields in a different order is not "identical"', async () => {
  const { store } = await runRoundTrip([
    [call('c1', { a: 1, b: 2 })],
    [call('c2', { b: 2, a: 1 })],
    [{ type: 'text', text: 'done' }],
  ]);

  assert.equal(
    reminders(store.events).length,
    0,
    'JSON key order is part of the v1 comparison (ADR-120 ①, normalizeCall-stable)',
  );
});
