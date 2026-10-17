import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import type { ModelChunk, ModelRequest } from '../src/index.js';
import { openEndedTransport, replayTransport, settlesWithin, type ReplayTransport } from './support.js';

// Hand-written bytes, for the same reason as the OpenAI tests: T4 owns the recorded
// fixtures, and until then the value is in exercising the SDK's own SSE parser rather
// than a stand-in for it. Unlike OpenAI, this protocol names each event on its own line.

function sse(events: readonly { type: string }[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const messageStart = (usage: Record<string, unknown>) => ({
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { output_tokens: 1, ...usage },
  },
});

const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const blockStop = (index: number) => ({ type: 'content_block_stop', index });
const messageStop = { type: 'message_stop' };

const toolStart = (index: number, id: string, name: string) => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', id, name, input: {} },
});
const jsonDelta = (index: number, partial: string) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json: partial },
});
const messageDelta = (stopReason: string | null, outputTokens: number) => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason, stop_sequence: null },
  usage: { output_tokens: outputTokens },
});

function model(r: ReplayTransport) {
  return anthropicModel({ apiKey: 'k', fetch: r.fetch });
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'claude-test', maxTokens: 1024, ...overrides };
}

async function collect(m: ReturnType<typeof anthropicModel>, req: ModelRequest, signal?: AbortSignal): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const part of m.stream(req, signal ?? new AbortController().signal)) out.push(part);
  return out;
}

const usages = (parts: readonly ModelChunk[]) => parts.flatMap((p) => (p.type === 'usage' ? [p.usage] : []));

test('text deltas arrive as text chunks', async () => {
  const r = replayTransport(
    sse([messageStart({ input_tokens: 5 }), textStart, textDelta('Hel'), textDelta('lo'), blockStop(0), messageDelta('end_turn', 2), messageStop]),
  );
  const parts = await collect(model(r), request());

  assert.deepEqual(
    parts.filter((p) => p.type === 'text'),
    [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }],
  );
});

test('tool input split across deltas is assembled from its content block', async () => {
  const r = replayTransport(
    sse([
      messageStart({ input_tokens: 5 }),
      toolStart(0, 'toolu_1', 'read_file'),
      jsonDelta(0, '{"path"'),
      jsonDelta(0, ':"a.txt"}'),
      blockStop(0),
      messageDelta('tool_use', 3),
      messageStop,
    ]),
  );
  const parts = await collect(model(r), request());

  assert.deepEqual(
    parts.filter((p) => p.type === 'tool_call'),
    [{ type: 'tool_call', call: { callId: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } } }],
  );
});

test('message_delta usage is merged into message_start, not written over it', async () => {
  // The trap this protocol sets: `message_delta` reports a cumulative output count and
  // omits the input and cache counters entirely, so a replace loses them (ADR-040 — the
  // SDK's own test suite has a case for exactly this).
  const r = replayTransport(
    sse([
      messageStart({ input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }),
      textStart,
      textDelta('hi'),
      blockStop(0),
      messageDelta('end_turn', 12),
      messageStop,
    ]),
  );
  const parts = await collect(model(r), request());

  assert.deepEqual(usages(parts).at(-1), { input: 10, output: 12, cacheRead: 4, cacheCreation: 2 });
});

test('every reported usage is emitted, so a consumer can take the last one', async () => {
  const r = replayTransport(
    sse([messageStart({ input_tokens: 10 }), messageDelta('end_turn', 7), messageStop]),
  );
  const parts = await collect(model(r), request());

  assert.equal(usages(parts).length, 2);
  assert.equal(usages(parts)[0]?.output, 1, 'the count message_start carried');
  assert.equal(usages(parts)[1]?.output, 7, 'the cumulative count message_delta carried');
});

test('stop reasons the kernel knows are named; a vendor-only value keeps its name', async () => {
  const known = await collect(
    model(replayTransport(sse([messageDelta('max_tokens', 1), messageStop]))),
    request(),
  );
  const other = await collect(
    model(replayTransport(sse([messageDelta('refusal', 1), messageStop]))),
    request(),
  );

  assert.deepEqual(known.filter((p) => p.type === 'stop'), [{ type: 'stop', reason: { kind: 'maxTokens', raw: 'max_tokens' } }]);
  assert.deepEqual(other.filter((p) => p.type === 'stop'), [{ type: 'stop', reason: { kind: 'other', raw: 'refusal' } }]);
});

test('a missing max_tokens is refused instead of invented', async () => {
  const r = replayTransport(sse([messageStop]));
  await assert.rejects(
    () => collect(model(r), { messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'claude-test' }),
    /requires max_tokens/,
  );
});

test('tool input that is not JSON fails loudly, naming the call', async () => {
  const r = replayTransport(sse([toolStart(0, 'toolu_1', 'broken'), jsonDelta(0, '{oops'), blockStop(0)]));
  await assert.rejects(() => collect(model(r), request()), /toolu_1 \(broken\) carried input that is not JSON/);
});

test('system is a top-level field, and tools are declared unwrapped', async () => {
  const r = replayTransport(sse([messageStart({ input_tokens: 1 }), messageStop]));
  const schema = { type: 'object', properties: { path: { type: 'string' } } };
  await collect(
    model(r),
    request({ system: 'be brief', tools: [{ name: 'read_file', description: 'read', risk: 'read', inputSchema: schema }] }),
  );

  const body = r.requests[0]?.body ?? {};
  assert.equal(body.system, 'be brief');
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.tools, [{ name: 'read_file', description: 'read', input_schema: schema }]);
  // No `system` message: this protocol would reject it.
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('consecutive tool results are merged into the one user turn that must carry them', async () => {
  // The shape this protocol requires, and the reason the flat history cannot be sent
  // as-is: two results for one assistant turn belong to a single user message.
  const r = replayTransport(sse([messageStart({ input_tokens: 1 }), messageStop]));
  await collect(
    model(r),
    request({
      messages: [
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            { callId: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
            { callId: 'toolu_2', name: 'read_file', input: { path: 'b.txt' } },
          ],
        },
        { role: 'tool', callId: 'toolu_1', ok: true, output: 'a' },
        { role: 'tool', callId: 'toolu_2', ok: false, output: 'b failed' },
      ],
    }),
  );

  assert.deepEqual((r.requests[0]?.body.messages as unknown[]).slice(-2), [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'b.txt' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'b failed', is_error: true },
      ],
    },
  ]);
});

test('the base URL is honoured, so a compatible endpoint is the same code path', async () => {
  const r = replayTransport(sse([messageStart({ input_tokens: 1 }), messageStop]));
  await collect(anthropicModel({ apiKey: 'k', baseURL: 'https://api.minimax.cn/anthropic', fetch: r.fetch }), request());

  assert.match(r.requests[0]?.url ?? '', /^https:\/\/api\.minimax\.cn\/anthropic\/v1\/messages/);
});

test('aborting mid-stream ends the iteration, so cancellation really takes effect', async () => {
  // Same property as the OpenAI adapter, and the same reasoning for how it is asserted:
  // this SDK bridges the caller's signal rather than forwarding the object, and it tears
  // the bridge down once the request ends — so the observable fact is that the stream
  // stops, not which signal object `fetch` was handed.
  const r = openEndedTransport(sse([messageStart({ input_tokens: 1 })]));
  const controller = new AbortController();
  const m = anthropicModel({ apiKey: 'k', fetch: r.fetch });
  const iterator = m.stream(request(), controller.signal)[Symbol.asyncIterator]();

  await iterator.next();
  controller.abort();

  assert.equal(await settlesWithin(iterator.next(), 1000), true, 'aborting must stop the stream, not hang it');
});
