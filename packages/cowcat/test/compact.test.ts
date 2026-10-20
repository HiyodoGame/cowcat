import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactContext,
  COMPACT_INSTRUCTION,
  runTurn,
  selectTailStart,
  Session,
  type KernelEvent,
  type Message,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

/**
 * ADR-072: compaction is a maintenance operation, not a turn.
 *
 * These tests pin the three properties the decision rests on: it writes its own event
 * pair, it sends the shadowed history as a prefix (with the instruction last), and a
 * failure leaves the conversation exactly as it was.
 */

const summaryChunks = [
  { type: 'text' as const, text: '## Objective\nShip the thing.\n' },
  { type: 'usage' as const, usage: { input: 900, output: 40, cacheRead: 0, cacheCreation: 0 } },
];

async function sessionWith(events: readonly { input: string; answer?: string }[]): Promise<{
  session: Session;
  store: MemoryEventStore;
}> {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_compact');
  for (const { input, answer } of events) {
    await session.openTurn(input);
    if (answer !== undefined) {
      await session.emit({
        type: 'model.message',
        turnId: session.turnId,
        text: answer,
        toolCalls: [],
        reasoning: [],
        stopReason: null,
      });
    }
    await session.transition('streaming');
    await session.transition('finishing');
    await session.transition('completed');
  }
  return { session, store };
}

function presetWith(window: number | undefined) {
  return {
    protocol: 'openai' as const,
    model: 'test-model',
    limits: { output: 1024, ...(window === undefined ? {} : { context: window }) },
    toolCalls: true,
  };
}

test('the kept tail starts at a user message, so tool calls stay with their results', () => {
  const messages: Message[] = [
    { role: 'user', text: 'a'.repeat(400) },
    { role: 'assistant', text: '', toolCalls: [{ callId: 'c1', name: 'Read', input: {} }], reasoning: [] },
    { role: 'tool', callId: 'c1', ok: true, output: 'x'.repeat(400), attachments: [] },
    { role: 'user', text: 'next' },
    { role: 'assistant', text: 'done', toolCalls: [], reasoning: [] },
  ];
  // A budget that only fits the last exchange still starts at the user message before it.
  assert.equal(selectTailStart(messages, 10), 3);
  // A budget that fits everything keeps everything.
  assert.equal(selectTailStart(messages, 100_000), 0);
});

test('a compaction writes its own event pair and replaces the head', async () => {
  const { session, store } = await sessionWith([
    { input: 'first request', answer: 'first answer' },
    { input: 'second request', answer: 'second answer' },
  ]);
  const before = session.state.messages.length;

  const model = new ScriptedModel([summaryChunks]);
  const outcome = await compactContext(
    { session, model, preset: presetWith(undefined), tools: [], keepTokens: 5 },
    'manual',
    new AbortController().signal,
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.dropped > 0, true);
  assert.equal(session.state.messages.length < before, true, 'the head is gone');

  const roles = session.state.messages.map((message) => message.role);
  assert.equal(roles[0], 'user', 'the summary is the first message');

  // The request is the shadowed history plus the instruction, nothing else.
  const request = model.requests[0];
  assert.ok(request !== undefined);
  const last = request.messages.at(-1);
  assert.deepEqual(last, { role: 'user', text: COMPACT_INSTRUCTION }, 'the instruction is the final user message');
  assert.equal(request.messages.length, outcome.dropped + 1);
  assert.equal(session.state.compactionOpen, false);

  const types = (await store.readAll('sess_compact')).map((event: KernelEvent) => event.type);
  assert.deepEqual(types.slice(-3), [
    'context.compaction.started',
    'context.compacted',
    'context.compaction.finished',
  ]);
});

test('the summary the model reads is wrapped, and its usage is recorded', async () => {
  const { session, store } = await sessionWith([
    { input: 'first request', answer: 'first answer' },
    { input: 'second request', answer: 'second answer' },
  ]);
  const model = new ScriptedModel([summaryChunks]);
  await compactContext(
    { session, model, preset: presetWith(undefined), tools: [], keepTokens: 5 },
    'auto',
    new AbortController().signal,
  );

  const first = session.state.messages[0];
  assert.ok(first !== undefined && first.role === 'user');
  assert.match(first.text, /<summary>/);
  assert.match(first.text, /Ship the thing\./);

  const compacted = (await store.readAll('sess_compact')).find((event) => event.type === 'context.compacted');
  assert.ok(compacted !== undefined);
  assert.deepEqual(compacted.usage, { input: 900, output: 40, cacheRead: 0, cacheCreation: 0 });
  assert.equal(compacted.trigger, 'auto');
  assert.equal(compacted.shadowed.length, compacted.dropped);
});

test('a failing summarizer leaves the history untouched and records why', async () => {
  const { session } = await sessionWith([
    { input: 'first request', answer: 'first answer' },
    { input: 'second request', answer: 'second answer' },
  ]);
  const before = session.state.messages;

  const model = new ScriptedModel([new Error('upstream 503')]);
  const outcome = await compactContext(
    { session, model, preset: presetWith(undefined), tools: [], keepTokens: 5 },
    'auto',
    new AbortController().signal,
  );

  assert.equal(outcome.ok, false);
  assert.match(String(outcome.reason), /upstream 503/);
  assert.deepEqual(session.state.messages, before, 'the turn keeps the history it had');
  assert.equal(session.state.compactionOpen, false, 'the lock is released even on failure');
});

test('nothing to compact writes nothing at all', async () => {
  const { session, store } = await sessionWith([{ input: 'only one exchange', answer: 'only one answer' }]);
  const before = (await store.readAll('sess_compact')).length;
  const model = new ScriptedModel([]);
  const outcome = await compactContext(
    { session, model, preset: presetWith(undefined), tools: [], keepTokens: 1_000_000 },
    'auto',
    new AbortController().signal,
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, null, 'not a failure: there was nothing to do');
  assert.equal(model.requests.length, 0, 'no model call is made');
  assert.equal((await store.readAll('sess_compact')).length, before, 'and nothing is written');
});

test('a turn over the ceiling compacts first, then answers from the compacted history', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_turn');
  const model = new ScriptedModel([summaryChunks, [{ type: 'text', text: 'answered after compaction' }]]);
  const deps = turnDeps(session, model, { preset: { limits: { output: 1024, context: 400 } } });

  const outcome = await runTurn(deps, 'x'.repeat(2_000), new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.deepEqual(outcome.notes, []);

  const types = (await store.readAll('sess_turn')).map((event: KernelEvent) => event.type);
  assert.equal(types.includes('context.compaction.started'), true);
  assert.equal(types.includes('context.compacted'), true);
  assert.equal(types.includes('context.compaction.finished'), true);

  // The answer request is built from the summary, not the original prompt.
  const answer = model.requests[1];
  assert.ok(answer !== undefined);
  const first = answer.messages[0];
  assert.ok(first !== undefined && first.role === 'user');
  assert.match(first.text, /<summary>/);
});

test('a failed compaction does not fail the turn, it reports a note', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_turn_fail');
  const model = new ScriptedModel([new Error('summarizer down'), [{ type: 'text', text: 'still answered' }]]);
  const deps = turnDeps(session, model, { preset: { limits: { output: 1024, context: 400 } } });

  const outcome = await runTurn(deps, 'x'.repeat(2_000), new AbortController().signal);
  assert.equal(outcome.state, 'completed', 'the turn completes on the history it has');
  assert.deepEqual(outcome.notes, [{ kind: 'compaction-failed', reason: 'summarizer down' }]);
});
