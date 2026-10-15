// Attachment plumbing: how tool results carrying images/PDFs become Anthropic
// content blocks and OpenAI tool+user message pairs, and how their cost is
// accounted for without letting base64 into the transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { toAnthropicMessages, buildAnthropicRequestBody } from '../src/llm/anthropic.js';
import { toOpenAIMessages, OpenAIProvider } from '../src/llm/openai.js';
import { estimateTokens, renderForCompact } from '../src/prompts/compact.js';
import { analyzeContext } from '../src/contextviz.js';
import { makeAttachment } from '../src/attach.js';
import { makePng } from './fixtures/media.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cowcat-attach-'));
}

function imageAttachment(dir, { name = 'shot.png', width = 4, height = 3, tokens = 900 } = {}) {
  const png = makePng(width, height);
  const path = join(dir, name);
  writeFileSync(path, png);
  return { path, png, att: makeAttachment({ type: 'image', mediaType: 'image/png', path, bytes: png.length, tokens, width, height }) };
}

function docAttachment(dir, tokens = 4500) {
  const path = join(dir, 'paper.pdf');
  writeFileSync(path, Buffer.from('%PDF-1.4\nfake\n%%EOF\n'));
  return makeAttachment({ type: 'document', mediaType: 'application/pdf', path, bytes: 20, tokens, pages: 3 });
}

// A turn: assistant calls Read (and maybe Bash in parallel), results come back in
// one user message — the shape loop.js produces.
function turn(results) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/x/shot.png' } },
        ...(results.length > 1 ? [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } }] : []),
      ],
    },
    { role: 'user', content: results },
  ];
}

// --- Anthropic ---------------------------------------------------------------

test('anthropic: an image rides inside the tool_result content array', () => {
  const dir = tmp();
  const { path, png, att } = imageAttachment(dir);
  const wire = toAnthropicMessages(turn([{ type: 'tool_result', tool_use_id: 'tu_1', content: '[image] shot.png', attachments: [att] }]));

  assert.equal(wire.length, 2);
  const tr = wire[1].content[0];
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.tool_use_id, 'tu_1');
  assert.ok(Array.isArray(tr.content));
  assert.deepEqual(tr.content.map((b) => b.type), ['text', 'image']);
  assert.equal(tr.content[0].text, '[image] shot.png');
  assert.equal(tr.content[1].source.type, 'base64');
  assert.equal(tr.content[1].source.media_type, 'image/png');
  assert.equal(tr.content[1].source.data, png.toString('base64'));
  assert.equal(wire[1].role, 'user');
  assert.equal(path.startsWith(dir), true);
});

test('anthropic: documents become sibling blocks, and tool_results still lead the message', () => {
  const dir = tmp();
  const { att: img } = imageAttachment(dir);
  const doc = docAttachment(dir);
  const wire = toAnthropicMessages(turn([
    { type: 'tool_result', tool_use_id: 'tu_1', content: '[pdf] paper.pdf', attachments: [doc] },
    { type: 'tool_result', tool_use_id: 'tu_2', content: '[image] shot.png', attachments: [img] },
  ]));

  const content = wire[1].content;
  assert.deepEqual(content.map((b) => b.type), ['tool_result', 'tool_result', 'document']);
  assert.equal(content[2].source.media_type, 'application/pdf');
  assert.match(content[0].content[0].text, /paper\.pdf/);
  // the image stayed inside its own tool_result
  assert.equal(content[1].content[1].type, 'image');
});

test('anthropic: text-only results keep the plain string form (no wire change)', () => {
  const wire = toAnthropicMessages(turn([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]));
  assert.equal(wire[1].content[0].content, 'ok');
  const plain = toAnthropicMessages([{ role: 'user', content: 'hello' }]);
  assert.equal(plain[0].content, 'hello');
});

test('anthropic: a vanished file degrades to a text note instead of failing the request', () => {
  const dir = tmp();
  const att = makeAttachment({ type: 'image', mediaType: 'image/png', path: join(dir, 'gone.png'), bytes: 10, tokens: 900 });
  const wire = toAnthropicMessages(turn([{ type: 'tool_result', tool_use_id: 'tu_1', content: '[image] gone.png', attachments: [att] }]));
  const parts = wire[1].content[0].content;
  assert.deepEqual(parts.map((b) => b.type), ['text', 'text']);
  assert.match(parts[1].text, /\[image unavailable: gone\.png \(file no longer exists\)\]/);
  assert.equal(JSON.stringify(wire).includes('base64'), false);
});

test('anthropic: cache breakpoint marking survives an attachment as the last block', () => {
  const dir = tmp();
  const { att } = imageAttachment(dir);
  const body = buildAnthropicRequestBody(
    { model: 'm', maxTokens: 1024, cache: true },
    {
      system: 'sys',
      messages: turn([{ type: 'tool_result', tool_use_id: 'tu_1', content: '[image] shot.png', attachments: [att] }]),
      stream: true,
    },
  );
  const last = body.messages[body.messages.length - 1];
  assert.equal(last.content[last.content.length - 1].cache_control.type, 'ephemeral');
});

// --- OpenAI-compatible -------------------------------------------------------

test('openai: tool message first, then a user message carrying the images', () => {
  const dir = tmp();
  const { png, att } = imageAttachment(dir);
  const wire = toOpenAIMessages(null, turn([{ type: 'tool_result', tool_use_id: 'tu_1', content: '[image] shot.png', attachments: [att] }]));

  assert.deepEqual(wire.map((m) => m.role), ['assistant', 'tool', 'user']);
  assert.equal(wire[1].tool_call_id, 'tu_1');
  assert.match(wire[1].content, /\[image\] shot\.png/);
  assert.match(wire[1].content, /\[attached: shot\.png \(image\/png, 4x3, .*\)\]/);
  assert.equal(wire[2].content[0].type, 'text');
  assert.match(wire[2].content[0].text, /1 image attached/);
  assert.equal(wire[2].content[1].type, 'image_url');
  assert.equal(wire[2].content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
});

test('openai: the image user message lands before any reminder text of the same turn', () => {
  const dir = tmp();
  const { att } = imageAttachment(dir);
  const wire = toOpenAIMessages(null, turn([
    { type: 'tool_result', tool_use_id: 'tu_1', content: '[image] shot.png', attachments: [att] },
    { type: 'text', text: '<system-reminder>today is friday</system-reminder>' },
  ]));
  assert.deepEqual(wire.map((m) => m.role), ['assistant', 'tool', 'user', 'user']);
  assert.equal(wire[2].content[1].type, 'image_url');
  assert.equal(wire[3].content, '<system-reminder>today is friday</system-reminder>');
});

test('openai: two parallel tool results keep tool messages adjacent, images batched after', () => {
  const dir = tmp();
  const a = imageAttachment(dir, { name: 'a.png' });
  const b = imageAttachment(dir, { name: 'b.png' });
  const wire = toOpenAIMessages(null, turn([
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'first', attachments: [a.att] },
    { type: 'tool_result', tool_use_id: 'tu_2', content: 'second', attachments: [b.att] },
  ]));
  assert.deepEqual(wire.map((m) => m.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(wire[3].content.length, 3); // text + 2 images
  assert.match(wire[3].content[0].text, /2 images attached/);
});

test('openai: a document attachment is reported, never sent as an image', () => {
  const dir = tmp();
  const doc = docAttachment(dir);
  const wire = toOpenAIMessages(null, turn([{ type: 'tool_result', tool_use_id: 'tu_1', content: '[pdf] paper.pdf', attachments: [doc] }]));
  assert.deepEqual(wire.map((m) => m.role), ['assistant', 'tool']);
  assert.match(wire[1].content, /not supported by this protocol: application\/pdf/);
});

test('openai: text-only turns are untouched', () => {
  const wire = toOpenAIMessages('sys', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ]);
  assert.deepEqual(wire, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

// Regression (P1, found while wiring attachments): plain-text messages — the
// user's prompt, the compact wrapper, a sub-agent prompt — carry `content` as a
// string. Iterating that string as if it were a block array dropped the message
// entirely, so an OpenAI-compatible request went out with no user prompt at all.
test('openai: plain string content is passed through, not dropped', () => {
  const wire = toOpenAIMessages(null, [
    { role: 'user', content: 'PLEASE-ECHO-THIS-PROMPT' },
    { role: 'assistant', content: 'plain assistant text' },
    { role: 'user', content: 'continued from a summary', __compact: true },
  ]);
  assert.deepEqual(wire, [
    { role: 'user', content: 'PLEASE-ECHO-THIS-PROMPT' },
    { role: 'assistant', content: 'plain assistant text' },
    { role: 'user', content: 'continued from a summary' },
  ]);
});

test('wire: a request through OpenAIProvider.chat really carries the prompt', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const provider = new OpenAIProvider({
      baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'stub', maxTokens: 16,
    });
    await provider.chat({
      messages: [
        { role: 'user', content: 'PLEASE-ECHO-THIS-PROMPT' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: 'continued from a summary', __compact: true },
      ],
      stream: false,
    });
    const flat = JSON.stringify(seen[0].messages);
    assert.match(flat, /PLEASE-ECHO-THIS-PROMPT/);
    assert.match(flat, /continued from a summary/);
    assert.equal(seen[0].messages[0].content, 'PLEASE-ECHO-THIS-PROMPT');
  } finally {
    server.close();
  }
});

test('openai: a reminder block is separated from the user prompt by a newline', () => {
  const wire = toOpenAIMessages(null, [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>The current date is 2026-10-16.</system-reminder>' },
        { type: 'text', text: 'fix the login bug' },
      ],
    },
  ]);
  assert.equal(wire[0].content, '<system-reminder>The current date is 2026-10-16.</system-reminder>\nfix the login bug');
});

test('compact: plain-text messages are rendered, not erased', () => {
  const rendered = renderForCompact({ role: 'user', content: '请修复登录 bug' });
  assert.equal(rendered, '<user>请修复登录 bug</user>');
  assert.match(renderForCompact({ role: 'assistant', content: 'plain answer' }), /plain answer/);
});

// --- accounting --------------------------------------------------------------

test('compact: attachment labels are rendered and their tokens counted', () => {
  const dir = tmp();
  const { att } = imageAttachment(dir, { tokens: 1200 });
  const plain = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '[image] shot.png' }] }];
  const withImage = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '[image] shot.png', attachments: [att] }] }];

  const cheap = estimateTokens(plain);
  const costed = estimateTokens(withImage);
  assert.ok(costed >= cheap + 1200, `expected the image estimate to be added (${costed} vs ${cheap})`);
  assert.ok(costed < cheap + 1200 + 100, 'the reference metadata itself is negligible');

  const rendered = renderForCompact(withImage[0]);
  assert.match(rendered, /\[attached: shot\.png \(image\/png, 4x3/);
  assert.equal(rendered.includes('base64'), false);
});

test('contextviz: images show up in /context instead of looking free', () => {
  const dir = tmp();
  const { att } = imageAttachment(dir, { tokens: 800 });
  const maxTokens = 200000;
  const before = analyzeContext([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }], maxTokens);
  const after = analyzeContext([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok', attachments: [att] }] }], maxTokens);
  assert.ok(after.total >= before.total + 800);
});
