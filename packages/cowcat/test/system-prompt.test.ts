import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import { openAIModel } from '../src/adapters/model-openai.js';
import { compactContext, COWCAT_SYSTEM_PROMPT, runTurn, Session, type ModelChunk } from '../src/index.js';
import { MemoryEventStore, replayTransport, ScriptedModel, sessionDeps, turnDeps } from './support.js';

const preset = { protocol: 'openai', model: 'test-model', limits: { output: 1024 }, toolCalls: true } as const;

test('ordinary and compaction requests share the minimal system prompt', async () => {
  const model = new ScriptedModel([[{ type: 'text', text: 'older answer' }], [{ type: 'text', text: 'summary' }]]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_system');
  await runTurn(turnDeps(session, model), 'hello', new AbortController().signal);
  assert.equal(model.requests[0]?.system, COWCAT_SYSTEM_PROMPT);

  await compactContext({ session, model, preset, tools: [], keepTokens: 1 }, 'manual', new AbortController().signal);
  assert.equal(model.requests[1]?.system, COWCAT_SYSTEM_PROMPT);
});

test('OpenAI serializes one system role message', async () => {
  const raw = 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const transport = replayTransport(raw);
  const model = openAIModel({ apiKey: 'k', fetch: transport.fetch });
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream({ messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'test-model', system: COWCAT_SYSTEM_PROMPT }, new AbortController().signal)) chunks.push(chunk);
  const messages = transport.requests[0]?.body['messages'];
  assert.ok(Array.isArray(messages));
  const system = messages.filter((message) => (message as { role?: unknown }).role === 'system');
  assert.equal(system.length, 1);
  assert.deepEqual(system[0], { role: 'system', content: COWCAT_SYSTEM_PROMPT });
});

test('Anthropic serializes top-level system without duplicating it in messages', async () => {
  const raw = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const transport = replayTransport(raw);
  const model = anthropicModel({ apiKey: 'k', fetch: transport.fetch });
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream({ messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'test-model', maxTokens: 1024, system: COWCAT_SYSTEM_PROMPT }, new AbortController().signal)) chunks.push(chunk);
  assert.equal(transport.requests[0]?.body['system'], COWCAT_SYSTEM_PROMPT);
  const messages = transport.requests[0].body['messages'];
  assert.ok(Array.isArray(messages));
  assert.equal(messages.some((message) => (message as { role?: unknown }).role === 'system'), false);
});
