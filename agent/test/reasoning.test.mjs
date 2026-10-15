// P1: reasoning chains through OpenAI-compatible endpoints. GLM/DeepSeek/Kimi
// stream `reasoning_content`, OpenAI o-series uses `reasoning`; both must
// surface as local-only `thinking` blocks (never echoed back upstream) and
// stream to the UI via onThinking.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOpenAIMessage,
  aggregateOpenAIStream,
  toOpenAIMessages,
} from '../src/llm/openai.js';

const done = (events) => events.concat([{ __done: true }]);

test('openai: non-stream reasoning_content becomes a leading thinking block', () => {
  const msg = normalizeOpenAIMessage({
    choices: [{
      finish_reason: 'stop',
      message: {
        reasoning_content: '先检查一下目录结构',
        content: '好的',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.deepEqual(msg.content[0], { type: 'thinking', thinking: '先检查一下目录结构' });
  assert.equal(msg.content[1].type, 'text');
  assert.equal(msg.content[2].type, 'tool_use');
  assert.equal(msg.content[2].name, 'Bash');
});

test('openai: non-stream OpenAI-style `reasoning` field is also picked up', () => {
  const msg = normalizeOpenAIMessage({
    choices: [{ finish_reason: 'stop', message: { reasoning: 'hmm', content: 'ok' } }],
  });
  assert.deepEqual(msg.content[0], { type: 'thinking', thinking: 'hmm' });
});

test('openai: streamed reasoning_content aggregates and fires onThinking', () => {
  const seen = [];
  const events = done([
    { choices: [{ delta: { reasoning_content: '第一步：' } }] },
    { choices: [{ delta: { reasoning_content: '看文件' } }] },
    { choices: [{ delta: { content: '结论' } }] },
    { choices: [{ delta: null, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
  const out = aggregateOpenAIStream(events, null, (d) => seen.push(d));
  assert.deepEqual(seen, ['第一步：', '看文件'], 'every reasoning delta streams to the UI');
  assert.deepEqual(out.content[0], { type: 'thinking', thinking: '第一步：看文件' });
  assert.deepEqual(out.content[1], { type: 'text', text: '结论' });
  assert.equal(out.usage.completion_tokens, 2);
});

test('openai: reasoning and content may arrive in the same delta', () => {
  const events = done([
    { choices: [{ delta: { reasoning_content: 'r', content: 'c' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const out = aggregateOpenAIStream(events);
  assert.deepEqual(out.content.map((b) => b.type), ['thinking', 'text']);
});

test('openai: no reasoning -> no thinking block (plain endpoints unaffected)', () => {
  const events = done([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const out = aggregateOpenAIStream(events);
  assert.deepEqual(out.content, [{ type: 'text', text: 'hi' }]);
});

test('openai: upstream re-serialization still strips thinking blocks', () => {
  const out = toOpenAIMessages('sys', [
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'local only' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
  ]);
  const asst = out.find((m) => m.role === 'assistant');
  assert.equal(asst.content, 'answer', 'thinking is never echoed back upstream');
  assert.equal(asst.tool_calls.length, 1);
});
