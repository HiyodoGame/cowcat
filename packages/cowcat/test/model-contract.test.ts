import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  replay,
  runTurn,
  type KernelEvent,
  type ModelChunk,
  type ModelPort,
  type ModelUsage,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

// The model contract P4 added (ADR-035, ADR-040, ADR-041, ADR-045): usage, the stop
// reason and the model's own reasoning are facts the kernel receives from an adapter and
// has to record. Until this task the kernel could only receive text and tool calls, so
// none of them could be kept.

const usage: ModelUsage = { input: 12, output: 34, cacheRead: 5, cacheCreation: 6 };

async function setup(model: ModelPort) {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_1');
  const deps = turnDeps(session, model, { modelId: 'deepseek-flash' });
  return { store, session, deps };
}

const of = (events: readonly KernelEvent[], type: KernelEvent['type']) =>
  events.filter((e) => e.type === type);

// A model that reports usage and then waits to be cancelled — the case that made usage
// a separate event rather than a field on `model.message` (ADR-041).
function usageThenWaitForAbort(reported: ModelUsage): ModelPort {
  return {
    async *stream(_request, signal): AsyncIterable<ModelChunk> {
      yield { type: 'usage', usage: reported };
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve();
        });
      });
      throw new Error('aborted');
    },
  };
}

test('usage reaches the log as its own event (ADR-041)', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'hi' }, { type: 'usage', usage }]]);
  const { store, session, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  const events = await store.readAll('sess_1');
  const usageEvents = of(events, 'model.usage');
  assert.equal(usageEvents.length, 1);
  assert.deepEqual(usageEvents[0]?.type === 'model.usage' ? usageEvents[0].usage : null, usage);
  assert.equal(session.state.messages.length, 2, 'a usage event adds no message');
});

test('usage is written before the message it belongs to, and more than once if reported twice', async () => {
  const first: ModelUsage = { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 };
  const second: ModelUsage = { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 };
  // Anthropic reports an initial count and then a cumulative one, so the second number
  // is not a correction of the first — both arrivals are facts (ADR-040).
  const model = new ScriptedModel([
    [
      { type: 'usage', usage: first },
      { type: 'text', text: 'hi' },
      { type: 'usage', usage: second },
    ],
  ]);
  const { store, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  const order = (await store.readAll('sess_1'))
    .map((e) => e.type)
    .filter((type) => type === 'model.usage' || type === 'model.message');
  assert.deepEqual(order, ['model.usage', 'model.usage', 'model.message']);
});

test('usage survives a cancelled stream (the reason it is not a field on model.message)', async () => {
  const controller = new AbortController();
  const { store, deps } = await setup(usageThenWaitForAbort(usage));

  const turn = runTurn(deps, 'hi', controller.signal);
  // Let the generator reach its first yield, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const outcome = await turn;

  assert.deepEqual(outcome.state, 'cancelled');
  const events = await store.readAll('sess_1');
  assert.equal(of(events, 'model.usage').length, 1);
  assert.equal(of(events, 'model.message').length, 0, 'a cancelled stream writes no half message');
});

test('the stop reason is recorded on the message, kind and vendor value together (ADR-035)', async () => {
  const model = new ScriptedModel([
    [{ type: 'text', text: 'hi' }, { type: 'stop', reason: { kind: 'maxTokens', raw: 'length' } }],
  ]);
  const { store, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  const message = of(await store.readAll('sess_1'), 'model.message')[0];
  assert.deepEqual(message?.type === 'model.message' ? message.stopReason : null, {
    kind: 'maxTokens',
    raw: 'length',
  });
});

test('a model that reports no stop reason records null rather than a guess', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'hi' }]]);
  const { store, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  const message = of(await store.readAll('sess_1'), 'model.message')[0];
  assert.equal(message?.type === 'model.message' ? message.stopReason : 'missing', null);
});

test('a stop chunk does not end the stream: later chunks are still consumed', async () => {
  // Providers disagree about what follows a finishing chunk, so the end of the
  // iterator is the end (ADR-035; the same conclusion as agent/src/llm/openai.js:69-71).
  const model = new ScriptedModel([
    [
      { type: 'stop', reason: { kind: 'end', raw: 'stop' } },
      { type: 'text', text: 'late' },
    ],
  ]);
  const { store, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  const message = of(await store.readAll('sess_1'), 'model.message')[0];
  assert.equal(message?.type === 'model.message' ? message.text : null, 'late');
});

test('the request names the model the kernel decided on (ADR-035)', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'hi' }]]);
  const { deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  assert.equal(model.requests[0]?.model, 'deepseek-flash');
});

test('a log carrying usage replays to the same state', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'hi' }, { type: 'usage', usage }]]);
  const { store, session, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  assert.deepEqual(replay('sess_1', await store.readAll('sess_1')), session.state);
});

test('reasoning reaches the log verbatim, in the order it arrived (ADR-045)', async () => {
  // Both arms of the union, and a signature with nothing readable about it: the point is
  // that the kernel is a carrier here, not an interpreter. Anthropic rejects a block whose
  // opaque signature was re-derived or re-ordered, so "we kept it" has to mean "byte for
  // byte, position for position" (the adapter decides how to send it back).
  const model = new ScriptedModel([
    [
      { type: 'reasoning', block: { type: 'thinking', text: 'let me look', signature: 'sig-opaque-1' } },
      { type: 'reasoning', block: { type: 'redacted', data: 'encrypted-blob' } },
      { type: 'text', text: 'hi' },
    ],
  ]);
  const { store, session, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  const expected = [
    { type: 'thinking', text: 'let me look', signature: 'sig-opaque-1' },
    { type: 'redacted', data: 'encrypted-blob' },
  ];
  const message = of(await store.readAll('sess_1'), 'model.message')[0];
  assert.deepEqual(message?.type === 'model.message' ? message.reasoning : null, expected);
  // The reasoning is a sibling of the answer, never mixed into it.
  assert.deepEqual(session.state.messages.at(-1), {
    role: 'assistant',
    text: 'hi',
    toolCalls: [],
    reasoning: expected,
  });
});

test('a log carrying reasoning replays to the same state', async () => {
  // Reasoning rides on `model.message`, so this is also the guarantee that the blocks
  // survive a JSON round trip: the log is the source of truth, and a block that could not
  // be written back faithfully would make replay differ from the live state.
  const model = new ScriptedModel([
    [{ type: 'reasoning', block: { type: 'thinking', text: 'thinking', signature: 'sig' } }],
  ]);
  const { store, session, deps } = await setup(model);
  await runTurn(deps, 'hi', new AbortController().signal);

  assert.deepEqual(replay('sess_1', await store.readAll('sess_1')), session.state);
});
