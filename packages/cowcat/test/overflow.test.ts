import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import { openAIModel } from '../src/adapters/model-openai.js';
import { COMPACT_INSTRUCTION, ContextOverflowError, runTurn, Session, type ModelChunk, type ModelPort, type ModelRequest } from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

function errorTransport(status: number, body: string): typeof globalThis.fetch {
  return () => Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
}

async function drain(model: ModelPort, request: ModelRequest): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream(request, new AbortController().signal)) chunks.push(chunk);
  return chunks;
}

const request: ModelRequest = { messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'test-model', maxTokens: 1024 };

test('OpenAI normalizes only context-overflow failures', async () => {
  const overflow = errorTransport(400, '{"error":{"message":"context_length_exceeded: too many tokens in prompt","type":"invalid_request_error"}}');
  await assert.rejects(drain(openAIModel({ apiKey: 'k', fetch: overflow }), request), ContextOverflowError);
  const invalid = errorTransport(400, '{"error":{"message":"max_tokens is invalid","type":"invalid_request_error"}}');
  await assert.rejects(drain(openAIModel({ apiKey: 'k', fetch: invalid }), request), (error: unknown) => {
    assert.equal(error instanceof ContextOverflowError, false);
    return true;
  });
  const tooLarge = errorTransport(413, '{"error":{"message":"request entity too large"}}');
  await assert.rejects(drain(openAIModel({ apiKey: 'k', fetch: tooLarge }), request), ContextOverflowError);
});

test('Anthropic normalizes context-overflow failures', async () => {
  const overflow = errorTransport(400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long for the context window"}}');
  await assert.rejects(drain(anthropicModel({ apiKey: 'k', fetch: overflow }), request), ContextOverflowError);
  const tooLarge = errorTransport(413, '{"type":"error","error":{"type":"invalid_request_error","message":"request too large"}}');
  await assert.rejects(drain(anthropicModel({ apiKey: 'k', fetch: tooLarge }), request), ContextOverflowError);
});

test('an overflow compacts once and retries the same turn to completion', async () => {
  const model = new ScriptedModel([
    [{ type: 'text', text: 'older work '.repeat(500) }],
    new ContextOverflowError('context_length_exceeded'),
    [{ type: 'text', text: 'a compact handoff' }],
    [{ type: 'text', text: 'recovered' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_overflow');
  await runTurn(turnDeps(session, model), 'build history', new AbortController().signal);
  const outcome = await runTurn(turnDeps(session, model), 'continue', new AbortController().signal);

  assert.equal(outcome.state, 'completed', outcome.reason ?? undefined);
  assert.equal(model.requests.length, 4);
  const compactionMessage = model.requests[2]?.messages.at(-1);
  assert.ok(compactionMessage?.role === 'user');
  assert.match(compactionMessage.text, new RegExp(COMPACT_INSTRUCTION.slice(0, 30)));
  const retryMessage = model.requests[3]?.messages.at(-1);
  assert.ok(retryMessage?.role === 'user');
  assert.equal(retryMessage.text, 'continue');
  const compacted = store.events.filter((event) => event.type === 'context.compacted');
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0]?.trigger, 'overflow');
  assert.equal(store.events.filter((event) => event.type === 'turn.opened').length, 2);
});

test('overflow recovery is bounded to three shrink attempts', async () => {
  const model = new ScriptedModel([
    [{ type: 'text', text: 'older work '.repeat(500) }],
    new ContextOverflowError('one'),
    [{ type: 'text', text: 'summary '.repeat(500) }],
    new ContextOverflowError('two'),
    [{ type: 'text', text: 'summary '.repeat(500) }],
    new ContextOverflowError('three'),
    [{ type: 'text', text: 'summary '.repeat(500) }],
    new ContextOverflowError('four'),
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_exhausted');
  await runTurn(turnDeps(session, model), 'build history', new AbortController().signal);
  const outcome = await runTurn(turnDeps(session, model), 'continue', new AbortController().signal);

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.reason, 'four');
  assert.equal(model.requests.length, 8);
  assert.equal(store.events.filter((event) => event.type === 'context.compacted' && event.trigger === 'overflow').length, 3);
});

test('an ordinary model error never triggers compaction', async () => {
  const model = new ScriptedModel([new Error('invalid max_tokens')]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_ordinary_error');
  const outcome = await runTurn(turnDeps(session, model), 'continue', new AbortController().signal);
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.reason, 'invalid max_tokens');
  assert.equal(store.events.some((event) => event.type === 'context.compaction.started'), false);
});
