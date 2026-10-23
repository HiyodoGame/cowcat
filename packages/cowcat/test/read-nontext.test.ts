import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReadTool, type Attachment, type ToolGrant, type ToolResult } from '../src/index.js';

/**
 * T6: `Read`'s non-text branches. What is asserted here is the *reference*: which bytes
 * become which attachment, with which metadata, and what is refused rather than guessed.
 * What the model then sees is the adapters' business, and T5's tests cover that split.
 */
const noGrant: ToolGrant = { networkApproved: false, unsandboxedApproved: false };

function tree(files: Readonly<Record<string, string | Buffer>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-read-binary-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function read(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  return createReadTool({ cwd: root }).run(input, new AbortController().signal, noGrant);
}

/** A byte-accurate-enough header for each format, since only the header is parsed. */
function png(width: number, height: number, padding = 0): Buffer {
  const buffer = Buffer.alloc(24 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(11);
  buffer.writeUInt8(0xff, 0);
  buffer.writeUInt8(0xd8, 1);
  buffer.writeUInt8(0xff, 2);
  buffer.writeUInt8(0xc0, 3); // SOF0
  buffer.writeUInt16BE(0x0011, 4); // segment length
  buffer.writeUInt8(0x08, 6); // precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'latin1');
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  buffer.writeUInt8((width - 1) & 0xff, 24);
  buffer.writeUInt8(((width - 1) >> 8) & 0xff, 25);
  buffer.writeUInt8(((width - 1) >> 16) & 0xff, 26);
  buffer.writeUInt8((height - 1) & 0xff, 27);
  buffer.writeUInt8(((height - 1) >> 8) & 0xff, 28);
  buffer.writeUInt8(((height - 1) >> 16) & 0xff, 29);
  return buffer;
}

function only(result: ToolResult): Attachment {
  const attachment = result.attachments?.[0];
  assert.ok(attachment !== undefined, `expected one attachment, got ${JSON.stringify(result.attachments ?? null)}`);
  return attachment;
}

test('each accepted image format becomes an attachment with its real dimensions', async (t) => {
  const root = tree({
    'shot.png': png(320, 200),
    'anim.gif': gif(64, 48),
    'photo.jpg': jpeg(1024, 768),
    'art.webp': webp(800, 600),
  });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const [file, size, mediaType] of [
    ['shot.png', '320x200', 'image/png'],
    ['anim.gif', '64x48', 'image/gif'],
    ['photo.jpg', '1024x768', 'image/jpeg'],
    ['art.webp', '800x600', 'image/webp'],
  ] as const) {
    const result = await read(root, { file_path: file });
    assert.equal(result.ok, true, result.output);
    const attachment = only(result);
    assert.equal(attachment.type, 'image');
    assert.equal(attachment.mediaType, mediaType);
    assert.equal(attachment.path, join(root, file));
    assert.ok(attachment.bytes > 0);
    assert.match(result.output, new RegExp(`\\[image\\] ${file.replace('.', '\\.')} — ${mediaType}, ${size}`));
    assert.match(result.output, /attached for the model/);
    // The bytes are never in the result: an attachment is a reference (ADR-057).
    assert.ok(!result.output.includes('base64'));
    assert.deepEqual(result.truncation, { truncated: false, dropped: 0, reason: null });
  }
});

test('a PDF is attached with its page count, and an unparsable count is null', async (t) => {
  const root = tree({
    'spec.pdf': '%PDF-1.4\n/Type /Page\n/Type /Page\n/Type /Pages\n',
    'compressed.pdf': '%PDF-1.7\n<binary-ish, no page objects>',
  });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const counted = await read(root, { file_path: 'spec.pdf' });
  assert.equal(counted.ok, true);
  assert.match(counted.output, /application\/pdf, 2 pages/);
  assert.equal(only(counted).type, 'document');
  assert.equal(only(counted).mediaType, 'application/pdf');
  assert.equal(only(counted).pages, 2);

  const unknown = await read(root, { file_path: 'compressed.pdf' });
  assert.equal(unknown.ok, true);
  // 0 is "the counter could not find page objects", which is not reported — never "no pages".
  assert.equal(only(unknown).pages, null);
  assert.match(unknown.output, /application\/pdf, 1\.\d KB|application\/pdf, \d+ B/);
});

test('an attachment over the soft limit is refused with numbers, and allow_large is the escape', async (t) => {
  const big = png(64, 64, 5 * 1024 * 1024);
  const root = tree({ 'big.png': big });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const refused = await read(root, { file_path: 'big.png' });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /file too large to attach \(5\.0 MB; the limit is 5\.0 MB/);
  assert.match(refused.output, /set allow_large/);
  assert.equal(refused.attachments, undefined);

  const allowed = await read(root, { file_path: 'big.png', allow_large: true });
  assert.equal(allowed.ok, true);
  assert.equal(only(allowed).bytes, big.byteLength);
});

test('unsupported image formats are named, not silently attached', async (t) => {
  const bmp = Buffer.alloc(32);
  bmp.write('BM', 0, 'latin1');
  const root = tree({ 'old.bmp': bmp, 'modern.heic': Buffer.from('0000ftypheic', 'latin1') });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const asBmp = await read(root, { file_path: 'old.bmp' });
  assert.equal(asBmp.ok, false);
  assert.match(asBmp.output, /is a bmp image/);
  assert.match(asBmp.output, /png\/jpeg\/gif\/webp only/);

  const asHeic = await read(root, { file_path: 'modern.heic' });
  assert.equal(asHeic.ok, false);
  assert.match(asHeic.output, /is a heic image/);
});

test('a notebook is rendered cell by cell and never attached', async (t) => {
  const notebook = {
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'text\n'] },
      {
        cell_type: 'code',
        execution_count: 7,
        source: 'print("hi")',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: 'hi\n' },
          { output_type: 'execute_result', data: { 'text/plain': '42', 'image/png': 'AAAA' } },
          { output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['\u001B[31mTraceback\u001B[0m', 'line 2'] },
        ],
      },
    ],
  };
  const root = tree({ 'book.ipynb': JSON.stringify(notebook) });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await read(root, { file_path: 'book.ipynb' });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /\[notebook\] book\.ipynb — 2 cells \(1 markdown, 1 code\)/);
  assert.match(result.output, /--- cell \[1\] code exec:7 ---/);
  assert.match(result.output, /--- output \[1\.0\] stream ---\n1\thi/);
  assert.match(result.output, /--- output \[1\.1\] execute_result ---\n1\t42/);
  // An image output has no file behind it, so it is described and explicitly not attached.
  assert.match(result.output, /\[image output: image\/png, \d+ B — not attached/);
  assert.match(result.output, /--- output \[1\.2\] error ---\n1\tValueError: boom/);
  assert.match(result.output, /line 2/);
  assert.equal(result.attachments, undefined);
  assert.deepEqual(result.truncation, { truncated: false, dropped: 0, reason: null });
});

test('a notebook whose output hits its cap reports the truncation instead of hiding it', async (t) => {
  const notebook = {
    cells: [{ cell_type: 'code', source: 'big()', outputs: [{ output_type: 'stream', text: 'x'.repeat(25_000) }] }],
  };
  const root = tree({ 'big.ipynb': JSON.stringify(notebook) });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await read(root, { file_path: 'big.ipynb' });
  assert.equal(result.ok, true);
  assert.match(result.output, /\[output truncated: .* dropped\]/);
  const truncation = result.truncation;
  assert.ok(truncation !== undefined, 'the cap is reported');
  assert.equal(truncation.truncated, true);
  // `dropped: null` is "the producer stopped early, so the total is unknown" (ADR-053).
  assert.equal(truncation.dropped, null);
  assert.match(truncation.reason ?? '', /outputs capped at 20000 chars/);
});

test('a malformed notebook is an ordinary failure, not a crash', async (t) => {
  const root = tree({ 'broken.ipynb': '{"cells": ', 'empty.ipynb': '{"nbformat":4}' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const broken = await read(root, { file_path: 'broken.ipynb' });
  assert.equal(broken.ok, false);
  assert.match(broken.output, /not a readable notebook \(not valid JSON/);

  const noCells = await read(root, { file_path: 'empty.ipynb' });
  assert.equal(noCells.ok, false);
  assert.match(noCells.output, /notebook has no "cells" array/);
});
