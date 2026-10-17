import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAIModel } from '../src/adapters/model-openai.js';
import type { Message, ModelChunk, ModelRequest } from '../src/index.js';
import { openEndedTransport, replayTransport, settlesWithin } from './support.js';

// The wire bytes are hand-written here rather than recorded: T4 owns the fixture files
// and the recorder (ADR-042). What matters now is that they are bytes over an injected
// transport, so the SDK's own SSE parsing is exercised instead of being stubbed out.

function sse(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const chunk = (delta: unknown, finish: string | null = null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// The usage-only chunk, which is how usage normally arrives: `choices` is empty.
const usageOnly = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
};

const replay = (events: readonly unknown[]) => replayTransport(sse(events));

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'test-model', ...overrides };
}

async function collect(model: ReturnType<typeof openAIModel>, req: ModelRequest, signal?: AbortSignal): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const part of model.stream(req, signal ?? new AbortController().signal)) out.push(part);
  return out;
}

// Finds the one usage chunk, which keeps the assertions below about the numbers rather
// than about narrowing.
function usageOf(parts: readonly ModelChunk[]): { input: number; output: number; cacheRead: number; cacheCreation: number } {
  const found = parts.find((p) => p.type === 'usage');
  assert.ok(found?.type === 'usage', 'expected a usage chunk');
  return found.usage;
}

test('text deltas arrive as text chunks, in order', async () => {
  const r = replay([chunk({ content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop')]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());

  assert.deepEqual(
    parts.filter((p) => p.type === 'text'),
    [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }],
  );
});

test('tool-call arguments split across chunks are assembled into one whole call', async () => {
  const r = replay([
    chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
    chunk({}, 'tool_calls'),
  ]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());

  assert.deepEqual(parts.filter((p) => p.type === 'tool_call'), [
    { type: 'tool_call', call: { callId: 'call_a', name: 'read_file', input: { path: 'a.txt' } } },
  ]);
});

test('two calls reported out of order still come out in index order', async () => {
  const r = replay([
    chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'second', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'first', arguments: '{}' } }] }),
    chunk({}, 'tool_calls'),
  ]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());
  const names = parts.flatMap((p) => (p.type === 'tool_call' ? [p.call.name] : []));

  assert.deepEqual(names, ['first', 'second']);
});

test('a usage-only chunk does not crash and does report usage', async () => {
  // The trap: `choices` is empty on exactly the chunk that carries usage, so a loop
  // that reads `choices[0]` before checking has to be the one that breaks.
  const r = replay([chunk({ content: 'hi' }), usageOnly, chunk({}, 'stop')]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());

  assert.deepEqual(parts.filter((p) => p.type === 'usage'), [
    { type: 'usage', usage: { input: 10, output: 4, cacheRead: 0, cacheCreation: 0 } },
  ]);
});

test('cached input is read from the standard field, or from the vendor name DeepSeek uses', async () => {
  const standard = { ...usageOnly, usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 7 } } };
  const vendor = { ...usageOnly, usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_cache_hit_tokens: 8 } };

  const first = await collect(openAIModel({ apiKey: 'k', fetch: replay([standard]).fetch }), request());
  const second = await collect(openAIModel({ apiKey: 'k', fetch: replay([vendor]).fetch }), request());

  assert.equal(usageOf(first).cacheRead, 7);
  assert.equal(usageOf(second).cacheRead, 8);
});

test('the stop reason keeps the vendor value beside the kind the kernel compares', async () => {
  const r = replay([chunk({ content: 'x' }, 'length')]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());

  assert.deepEqual(parts.filter((p) => p.type === 'stop'), [{ type: 'stop', reason: { kind: 'maxTokens', raw: 'length' } }]);
});

test('a vendor stop value the kernel has no name for keeps its own name', async () => {
  const r = replay([chunk({ content: 'x' }, 'content_filter')]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());

  assert.deepEqual(parts.filter((p) => p.type === 'stop'), [
    { type: 'stop', reason: { kind: 'other', raw: 'content_filter' } },
  ]);
});

test('a chunk after finish_reason is still consumed', async () => {
  // Providers disagree here, which is why `finish_reason` records the reason and does
  // not end the loop (ADR-035).
  const r = replay([
    chunk({ content: 'a' }, 'tool_calls'),
    chunk({ tool_calls: [{ index: 0, id: 'call_late', function: { name: 'late', arguments: '{}' } }] }),
  ]);
  const parts = await collect(openAIModel({ apiKey: 'k', fetch: r.fetch }), request());

  assert.deepEqual(parts.flatMap((p) => (p.type === 'tool_call' ? [p.call.callId] : [])), ['call_late']);
});

test('arguments that are not JSON fail loudly instead of reaching a tool as a string', async () => {
  const r = replay([chunk({ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'broken', arguments: '{oops' } }] })]);
  const model = openAIModel({ apiKey: 'k', fetch: r.fetch });

  await assert.rejects(() => collect(model, request()), /call_x \(broken\) carried arguments that are not JSON/);
});

test('the request carries the model, the system prompt, the ceiling and the usage switch', async () => {
  const r = replay([chunk({ content: 'x' }, 'stop')]);
  await collect(
    openAIModel({ apiKey: 'k', fetch: r.fetch }),
    request({ system: 'be brief', maxTokens: 99, model: 'glm-5.3-flash', tools: [] }),
  );

  const body = r.requests[0]?.body ?? {};
  assert.equal(body.model, 'glm-5.3-flash');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 99);
  assert.deepEqual((body.messages as Message[])[0], { role: 'system', content: 'be brief' });
  // Tools are absent rather than an empty array: an empty `tools` list is not the same
  // request as no tools at all on some compatible endpoints.
  assert.equal('tools' in body, false);
});

test('the flat history is mapped to the wire shape, tools and results paired by id', async () => {
  const r = replay([chunk({ content: 'x' }, 'stop')]);
  await collect(
    openAIModel({ apiKey: 'k', fetch: r.fetch }),
    request({
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: '', toolCalls: [{ callId: 'call_a', name: 'read_file', input: { path: 'a.txt' } }] },
        { role: 'tool', callId: 'call_a', ok: true, output: 'contents' },
      ],
    }),
  );

  assert.deepEqual(r.requests[0]?.body.messages, [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      // `null` rather than `''` on a turn that only called tools.
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'contents' },
  ]);
});

test('a tool is declared with the schema it was given', async () => {
  const r = replay([chunk({ content: 'x' }, 'stop')]);
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  await collect(
    openAIModel({ apiKey: 'k', fetch: r.fetch }),
    request({ tools: [{ name: 'read_file', description: 'read a file', risk: 'read', inputSchema: schema }] }),
  );

  assert.deepEqual(r.requests[0]?.body.tools, [
    { type: 'function', function: { name: 'read_file', description: 'read a file', parameters: schema } },
  ]);
});

test('the base URL is honoured, so a compatible endpoint is the same code path', async () => {
  const r = replay([chunk({ content: 'x' }, 'stop')]);
  await collect(openAIModel({ apiKey: 'k', baseURL: 'https://api.deepseek.com', fetch: r.fetch }), request());

  assert.match(r.requests[0]?.url ?? '', /^https:\/\/api\.deepseek\.com\/chat\/completions/);
});

test('aborting mid-stream ends the iteration, so cancellation really takes effect', async () => {
  const r = openEndedTransport(sse([chunk({ content: 'x' })]));
  const controller = new AbortController();
  const model = openAIModel({ apiKey: 'k', fetch: r.fetch });
  const iterator = model.stream(request(), controller.signal)[Symbol.asyncIterator]();

  await iterator.next();
  controller.abort();

  assert.equal(await settlesWithin(iterator.next(), 1000), true, 'aborting must stop the stream, not hang it');
});
