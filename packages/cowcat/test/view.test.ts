// D11 (ADR-138/139): the View tool — gates, lazy vision resolution, and the
// ModelRequest.images wire shape on both protocol adapters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import { openAIModel } from '../src/adapters/model-openai.js';
import { createViewTool } from '../src/adapters/tools/view.js';
import {
  makeAttachment,
  type Attachment,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
} from '../src/index.js';
import { replayTransport } from './support.js';

function dir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-view-')));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const grant = { networkApproved: false, unsandboxedApproved: false } as const;

const sse = (events: readonly unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

async function drain(model: ModelPort, request: ModelRequest): Promise<void> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream(request, new AbortController().signal)) chunks.push(chunk);
}

/** A vision port that records the request and answers with canned text. */
function fakeVision(answer: string): { vision: () => { port: ModelPort; model: string }; seen: () => ModelRequest | null } {
  let seen: ModelRequest | null = null;
  const port: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      seen = request;
      yield { type: 'text', text: answer };
    },
  };
  return { vision: () => ({ port, model: 'vision-model' }), seen: () => seen };
}

test('View reads an image through the vision endpoint and returns its text answer', async () => {
  const cwd = dir();
  const file = join(cwd, 'shot.png');
  writeFileSync(file, PNG);
  const fake = fakeVision('the screenshot says: TESTS MUST PASS');

  const tool = createViewTool({ cwd, vision: fake.vision });
  const result = await tool.run({ path: 'shot.png' }, new AbortController().signal, grant);

  assert.equal(result.ok, true);
  assert.equal(result.output, 'the screenshot says: TESTS MUST PASS');
  const request = fake.seen();
  assert.ok(request);
  assert.equal(request.model, 'vision-model');
  assert.deepEqual(request.tools, []);
  assert.equal(request.messages.length, 1);
  const message = request.messages[0];
  assert.ok(message && 'text' in message);
  assert.match(message.text, /OCR/);
  // The image rides the direct-call channel (ADR-139), as a reference — never bytes.
  const images = request.images ?? [];
  assert.equal(images.length, 1);
  const image = images[0];
  assert.ok(image);
  assert.equal(image.type, 'image');
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.path, file);
});

test('View passes a custom prompt through and refuses the gates loudly', async () => {
  const cwd = dir();
  const fake = fakeVision('unused');

  const tool = createViewTool({ cwd, vision: fake.vision });
  const signal = new AbortController().signal;

  const missing = await tool.run({ path: 'nope.png' }, signal, grant);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /no such file/);

  const textFile = join(cwd, 'notes.txt');
  writeFileSync(textFile, 'hello');
  const wrongType = await tool.run({ path: 'notes.txt' }, signal, grant);
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.output, /not a supported image/);

  const big = join(cwd, 'big.png');
  writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1));
  const tooBig = await tool.run({ path: 'big.png' }, signal, grant);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.output, /ceiling/);

  const empty = join(cwd, 'empty.png');
  writeFileSync(empty, Buffer.alloc(0));
  const emptyResult = await tool.run({ path: 'empty.png' }, signal, grant);
  assert.equal(emptyResult.ok, false);

  // A custom prompt replaces the OCR default.
  const file = join(cwd, 'ok.png');
  writeFileSync(file, PNG);
  await tool.run({ path: 'ok.png', prompt: 'what color dominates?' }, signal, grant);
  const request = fake.seen();
  assert.ok(request);
  const custom = request.messages[0];
  assert.ok(custom && 'text' in custom);
  assert.equal(custom.text, 'what color dominates?');
});

test('a throwing vision resolver becomes a refusal with guidance, not a crash', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'ok.png'), PNG);
  const error = Object.assign(new Error('ZHIPU_API_KEY is not set'), { guidance: 'export ZHIPU_API_KEY=...' });
  const tool = createViewTool({
    cwd,
    vision: () => {
      throw error;
    },
  });
  const result = await tool.run({ path: 'ok.png' }, new AbortController().signal, grant);
  assert.equal(result.ok, false);
  assert.match(result.output, /ZHIPU_API_KEY is not set/);
  assert.match(result.output, /export ZHIPU_API_KEY/);
  assert.match(result.output, /cowcat doctor/);
});

test('ModelRequest.images maps onto the first user message on the OpenAI wire', async () => {
  const cwd = dir();
  const file = join(cwd, 'pic.png');
  writeFileSync(file, PNG);
  const image: Attachment = makeAttachment({ type: 'image', mediaType: 'image/png', path: file, bytes: PNG.length });

  const transport = replayTransport(
    sse([
      { id: 'c1', choices: [{ delta: { content: 'ok' } }] },
      { id: 'c1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]),
  );
  const model = openAIModel({ apiKey: 'k', fetch: transport.fetch });
  await drain(model, { messages: [{ role: 'user', text: 'what is this?' }], tools: [], model: 'm', images: [image] });

  const body = transport.requests[0]?.body as { messages: Record<string, unknown>[] } | undefined;
  assert.ok(body);
  const user = body.messages.find((m) => m.role === 'user');
  assert.ok(user);
  const content = user.content as Record<string, unknown>[];
  const textPart = content[0];
  assert.ok(textPart);
  assert.equal(textPart.type, 'text');
  assert.equal((textPart as { text: string }).text, 'what is this?');
  const imagePart = content[1];
  assert.ok(imagePart);
  assert.equal(imagePart.type, 'image_url');
  assert.match((imagePart as { image_url: { url: string } }).image_url.url, /^data:image\/png;base64,/);
});

test('ModelRequest.images maps onto the first user message on the Anthropic wire', async () => {
  const cwd = dir();
  const file = join(cwd, 'pic.png');
  writeFileSync(file, PNG);
  const image: Attachment = makeAttachment({ type: 'image', mediaType: 'image/png', path: file, bytes: PNG.length });

  const anthropicSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n',
  ].join('');
  const transport = replayTransport(anthropicSse);
  const model = anthropicModel({ apiKey: 'k', fetch: transport.fetch });
  await drain(model, {
    messages: [{ role: 'user', text: 'what is this?' }],
    tools: [],
    model: 'claude-test',
    maxTokens: 100,
    images: [image],
  });

  const body = transport.requests[0]?.body as { messages: { role: string; content: Record<string, unknown>[] }[] } | undefined;
  assert.ok(body);
  const user = body.messages.find((m) => m.role === 'user');
  assert.ok(user);
  const textBlock = user.content[0];
  assert.ok(textBlock);
  assert.equal(textBlock.type, 'text');
  const imageBlock = user.content[1];
  assert.ok(imageBlock);
  assert.equal(imageBlock.type, 'image');
  const source = (imageBlock as { source: { type: string; media_type: string; data: string } }).source;
  assert.equal(source.type, 'base64');
  assert.equal(source.media_type, 'image/png');
  assert.equal(source.data, PNG.toString('base64'));
});

test('View caps long vision answers instead of flooding the conversation', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'ok.png'), PNG);
  let yielded = 0;
  const chatty: ModelPort = {
    async *stream(): AsyncIterable<ModelChunk> {
      while (yielded < 20) {
        yielded += 1;
        yield { type: 'text', text: 'x'.repeat(2000) };
      }
    },
  };
  const tool = createViewTool({ cwd, vision: () => ({ port: chatty, model: 'm' }) });
  const result = await tool.run({ path: 'ok.png' }, new AbortController().signal, grant);
  assert.equal(result.ok, true);
  assert.equal(result.truncation?.truncated, true);
  assert.match(result.output, /truncated/);
});
