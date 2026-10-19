import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import { openAIModel } from '../src/adapters/model-openai.js';
import {
  ATTACHMENT_HARD_LIMIT_BYTES,
  AttachmentUnavailableError,
  makeAttachment,
  materializeAttachment,
  type Attachment,
  type Message,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
} from '../src/index.js';
import { replayTransport } from './support.js';

/**
 * ADR-057's other half: "两个协议各自映射". The internal message is flat and identical
 * on both sides; what a request looks like is protocol knowledge, and these tests are
 * what keeps the two encodings from being assumed to be the same thing.
 */
const IMAGE = Buffer.from('fake-png-payload');
const DOCUMENT = Buffer.from('%PDF-1.4 fake document');

function anthropicSse(): string {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function openaiSse(): string {
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events = [chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}

interface Fixture {
  readonly dir: string;
  readonly image: Attachment;
  readonly document: Attachment;
  cleanup(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-wire-'));
  const imagePath = join(dir, 'shot.png');
  const documentPath = join(dir, 'spec.pdf');
  writeFileSync(imagePath, IMAGE);
  writeFileSync(documentPath, DOCUMENT);
  return {
    dir,
    image: makeAttachment({
      type: 'image',
      mediaType: 'image/png',
      path: imagePath,
      bytes: IMAGE.byteLength,
      width: 8,
      height: 6,
    }),
    document: makeAttachment({
      type: 'document',
      mediaType: 'application/pdf',
      path: documentPath,
      bytes: DOCUMENT.byteLength,
      pages: 2,
    }),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function requestWith(attachments: readonly Attachment[]): ModelRequest {
  const tool: Message = { role: 'tool', callId: 'c1', ok: true, output: 'Read the file', attachments };
  return { messages: [{ role: 'user', text: 'look' }, tool], tools: [], model: 'test-model', maxTokens: 64 };
}

async function drain(model: ModelPort, request: ModelRequest): Promise<void> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream(request, new AbortController().signal)) chunks.push(chunk);
}

/** The wire body is JSON; these assertions are about its shape, so they narrow explicitly. */
function bodyOf(transport: ReturnType<typeof replayTransport>): { messages: Record<string, unknown>[] } {
  const body = transport.requests[0]?.body;
  assert.ok(body !== undefined, 'the adapter sent a request');
  return body as unknown as { messages: Record<string, unknown>[] };
}

/** The user turn the tool result rides in — not the plain user message that precedes it. */
function toolResultCarrier(messages: Record<string, unknown>[]): Record<string, unknown> {
  const carrier = messages.find(
    (message) =>
      message['role'] === 'user' &&
      Array.isArray(message['content']) &&
      (message['content'] as Record<string, unknown>[]).some((block) => block['type'] === 'tool_result'),
  );
  assert.ok(carrier !== undefined, 'the tool result went out');
  return carrier;
}

test('anthropic: the attachment rides inside the tool result it belongs to', async () => {
  const fx = fixture();
  try {
    const transport = replayTransport(anthropicSse());
    await drain(anthropicModel({ apiKey: 'test', fetch: transport.fetch }), requestWith([fx.image, fx.document]));

    const carrier = toolResultCarrier(bodyOf(transport).messages);
    const content = carrier['content'] as Record<string, unknown>[];
    assert.equal(content.length, 1);
    const result = content[0];
    assert.ok(result !== undefined);
    assert.equal(result['type'], 'tool_result');
    assert.equal(result['tool_use_id'], 'c1');

    const blocks = result['content'] as Record<string, unknown>[];
    assert.equal(blocks.length, 3, 'text plus the image plus the document');
    assert.deepEqual(blocks[0], { type: 'text', text: 'Read the file' });
    assert.deepEqual(blocks[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: IMAGE.toString('base64') },
    });
    assert.deepEqual(blocks[2], {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: DOCUMENT.toString('base64') },
    });
  } finally {
    fx.cleanup();
  }
});

test('openai: the attachment goes out as the next user turn, documents as a reference', async () => {
  const fx = fixture();
  try {
    const transport = replayTransport(openaiSse());
    await drain(openAIModel({ apiKey: 'test', fetch: transport.fetch }), requestWith([fx.image, fx.document]));

    const messages = bodyOf(transport).messages;
    const tool = messages.find((message) => message['role'] === 'tool');
    assert.equal(tool?.['content'], 'Read the file', 'the result itself stays a plain string');

    // The shape Chat Completions forces: a `tool` message cannot carry content parts, so
    // the image follows as a user turn.
    const carrier = messages.find((message) => message['role'] === 'user' && Array.isArray(message['content']));
    const parts = carrier?.['content'] as Record<string, unknown>[];
    const note = parts[0];
    assert.ok(note !== undefined);
    assert.equal(note['type'], 'text');
    assert.deepEqual(parts[1], {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${IMAGE.toString('base64')}` },
    });
    assert.equal(parts.length, 2, 'the document is not inlined');
    assert.match(String(note['text']), /spec\.pdf/, 'it is named instead — the model is told what it did not get');
    assert.match(String(note['text']), /no portable document part/);
  } finally {
    fx.cleanup();
  }
});

test('a tool result with no attachments looks exactly as it did before ADR-057', async () => {
  const transport = replayTransport(anthropicSse());
  await drain(anthropicModel({ apiKey: 'test', fetch: transport.fetch }), requestWith([]));

  const content = toolResultCarrier(bodyOf(transport).messages)['content'] as Record<string, unknown>[];
  const result = content[0];
  assert.ok(result !== undefined);
  assert.equal(result['content'], 'Read the file', 'a string, not a one-element block array');
});

test('a file that is gone is named in the request instead of failing the turn (ADR-069)', async () => {
  const gone = join(tmpdir(), 'cowcat-does-not-exist-9f3a.png');
  const ghost = makeAttachment({ type: 'image', mediaType: 'image/png', path: gone, bytes: 4 });
  for (const [name, model, sse] of [
    ['anthropic', (fetch: typeof globalThis.fetch) => anthropicModel({ apiKey: 'test', fetch }), anthropicSse()],
    ['openai', (fetch: typeof globalThis.fetch) => openAIModel({ apiKey: 'test', fetch }), openaiSse()],
  ] as const) {
    const transport = replayTransport(sse);
    // The whole point: this resolves. A rejection here fails the turn *and*, because the
    // reference stays in the history, every later turn of that session.
    await drain(model(transport.fetch), requestWith([ghost]));

    const body = JSON.stringify(bodyOf(transport));
    assert.match(body, /attachment unavailable/, `${name}: the model is told`);
    assert.match(body, /gone or unreadable/, `${name}: and told why`);
    assert.ok(body.includes(gone.replace(/\\/g, '\\\\')) || body.includes(gone), `${name}: the note names the file`);
    assert.ok(!body.includes('image_url') && !body.includes('"image"'), `${name}: no image block is invented`);
  }
});

test('an attachment over the hard limit degrades the same way, not into a failed turn', async () => {
  const huge = makeAttachment({ type: 'image', mediaType: 'image/png', path: '/nowhere-huge.png', bytes: ATTACHMENT_HARD_LIMIT_BYTES + 1 });
  const transport = replayTransport(anthropicSse());
  await drain(anthropicModel({ apiKey: 'test', fetch: transport.fetch }), requestWith([huge]));

  const carrier = toolResultCarrier(bodyOf(transport).messages);
  const result = (carrier['content'] as Record<string, unknown>[])[0];
  assert.ok(result !== undefined);
  const blocks = result['content'] as Record<string, unknown>[];
  assert.equal(blocks.length, 2);
  const note = blocks[1];
  assert.ok(note !== undefined);
  assert.equal(note['type'], 'text');
  assert.match(String(note['text']), /over the \d+ byte limit/);
});

test('the strict reading still refuses: `attachment.read` answers with an error, not a sentence', () => {
  const ghost = makeAttachment({
    type: 'image',
    mediaType: 'image/png',
    path: join(tmpdir(), 'cowcat-does-not-exist-9f3a.png'),
    bytes: 4,
  });
  assert.throws(
    () => materializeAttachment(ghost),
    (error: unknown) => {
      assert.ok(error instanceof AttachmentUnavailableError);
      assert.equal(error.path, ghost.path);
      assert.match(error.reason, /gone or unreadable/);
      return true;
    },
  );
});

test('the size limits refuse with numbers, and the declared size is checked first', () => {
  const overDeclared = makeAttachment({ type: 'image', mediaType: 'image/png', path: '/nowhere.png', bytes: 999 });
  assert.throws(
    () => materializeAttachment(overDeclared, { hardLimitBytes: 100 }),
    (error: unknown) => {
      assert.ok(error instanceof AttachmentUnavailableError);
      assert.match(error.reason, /declared 999 bytes is over the 100 byte limit/);
      return true;
    },
  );

  // The declared number is a claim; the file's real size is a fact. A file that grew
  // after it was attached is caught by the second check — the declared size here is
  // under the cap, the file on disk is not.
  const fx = fixture();
  try {
    const grown = makeAttachment({
      type: 'image',
      mediaType: 'image/png',
      path: fx.image.path,
      bytes: 1,
    });
    assert.throws(
      () => materializeAttachment(grown, { hardLimitBytes: 4 }),
      (error: unknown) => {
        assert.ok(error instanceof AttachmentUnavailableError);
        assert.match(error.reason, /is \d+ bytes, over the 4 byte limit/);
        return true;
      },
    );
    assert.equal(materializeAttachment(fx.image).base64, IMAGE.toString('base64'));
  } finally {
    fx.cleanup();
  }
});
