// P3-6 Read multimodal: magic-byte sniffing, attachment references, vision
// gating, and the Read tool's image / PDF / notebook branches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sniffBuffer, kindFromExtension, estimateImageTokens, countPdfPages, formatBytes,
} from '../src/imageinfo.js';
import {
  makeAttachment, materializeAttachment, materializeAll, attachmentLabel, attachmentTokens,
  validateAttachment, MAX_IMAGE_BYTES, MAX_PDF_BYTES,
} from '../src/attach.js';
import {
  visionCapability, visionRefusalMessage, lookupModel, looksLikeVisionUnsupported, visionOverride,
} from '../src/vision.js';
import { extractPdfText } from '../src/pdftext.js';
import { renderNotebook, parseNotebook } from '../src/notebook.js';
import { ReadTool } from '../src/tools/read.js';
import { makePng, makeJpeg, makeGif, makeWebp, makePdf, makeNotebookBuffer } from './fixtures/media.mjs';

// Vision-capable / non-vision models from the shipped catalog (assets/providers.json).
const VISION_MODEL = 'XiaomiMiMo/MiMo-V2.6-Pro';
const NO_VISION_MODEL = 'tencent/Hy4-preview';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cowcat-multimodal-'));
}

function writeFixture(dir, name, buf) {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

function ctxFor(dir, config = {}) {
  return { cwd: dir, readSet: new Set(), config };
}

// --- imageinfo ---------------------------------------------------------------

test('sniff: a real PNG parses its dimensions', () => {
  const info = sniffBuffer(makePng(3, 2));
  assert.equal(info.kind, 'png');
  assert.equal(info.mediaType, 'image/png');
  assert.equal(info.width, 3);
  assert.equal(info.height, 2);
});

test('sniff: jpeg walks to SOF, gif and webp read their headers', () => {
  const jpeg = sniffBuffer(makeJpeg(640, 480));
  assert.equal(jpeg.kind, 'jpeg');
  assert.equal(jpeg.mediaType, 'image/jpeg');
  assert.deepEqual([jpeg.width, jpeg.height], [640, 480]);

  const gif = sniffBuffer(makeGif(7, 9));
  assert.equal(gif.kind, 'gif');
  assert.deepEqual([gif.width, gif.height], [7, 9]);

  const webp = sniffBuffer(makeWebp(800, 600));
  assert.equal(webp.kind, 'webp');
  assert.deepEqual([webp.width, webp.height], [800, 600]);
});

test('sniff: pdf, text and binary are distinguished', () => {
  assert.equal(sniffBuffer(makePdf(['hello'])).kind, 'pdf');
  assert.equal(sniffBuffer(Buffer.from('plain text\n')).kind, 'text');
  assert.equal(sniffBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03])).kind, 'binary');
  assert.equal(sniffBuffer(Buffer.alloc(0)).kind, 'binary');
});

test('sniff: formats the model cannot take are named, not silently treated as text', () => {
  const bmp = sniffBuffer(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)]));
  assert.equal(bmp.kind, 'image-unsupported');
  assert.equal(bmp.format, 'bmp');
  const tiff = sniffBuffer(Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(8)]));
  assert.equal(tiff.format, 'tiff');
});

test('sniff: pdf page count is best-effort from /Type /Page', () => {
  const pdf = makePdf(['one']);
  assert.equal(countPdfPages(pdf), 1);
});

test('extension lookup cross-checks the content', () => {
  assert.equal(kindFromExtension('/x/y.png'), 'png');
  assert.equal(kindFromExtension('C:\\shots\\a.JPEG'), 'jpeg');
  assert.equal(kindFromExtension('report.pdf'), 'pdf');
  assert.equal(kindFromExtension('photo.bmp'), 'image-unsupported');
  assert.equal(kindFromExtension('notes.md'), null);
});

test('token estimate uses the published formula and honest fallbacks', () => {
  assert.equal(estimateImageTokens({ kind: 'png', width: 1000, height: 750 }), 1000);
  assert.equal(estimateImageTokens({ kind: 'png', bytes: 1024 }), 1600);
  assert.equal(estimateImageTokens({ kind: 'pdf', pages: 3 }), 4500);
  assert.equal(estimateImageTokens({ kind: 'pdf' }), 2000);
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('token estimate counts the resized geometry, not the raw pixels', () => {
  // Anthropic shrinks the long edge to 1568px before charging: a 3840x1200
  // screenshot costs ~1025 tokens, not the 6144 its raw pixel count suggests
  // (verified against real Windows wallpapers).
  assert.equal(estimateImageTokens({ kind: 'jpeg', width: 3840, height: 1200 }), 1025);
  assert.equal(estimateImageTokens({ kind: 'jpeg', width: 1568, height: 980 }), 2049);
  assert.equal(estimateImageTokens({ kind: 'jpeg', width: 1569, height: 1000 }),
    Math.ceil((1568 * Math.round(1000 * (1568 / 1569))) / 750));
});

// --- attach ------------------------------------------------------------------

test('attach: a reference materializes to base64, and never stores the bytes', () => {
  const dir = tmp();
  const png = makePng(2, 2);
  const path = writeFixture(dir, 'a.png', png);
  const att = makeAttachment({ type: 'image', mediaType: 'image/png', path, bytes: png.length, tokens: 1, width: 2, height: 2 });

  assert.deepEqual(Object.keys(att).sort(), ['bytes', 'height', 'mediaType', 'path', 'tokens', 'type', 'width']);
  const r = materializeAttachment(att);
  assert.equal(r.ok, true);
  assert.equal(r.block.mediaType, 'image/png');
  assert.equal(r.block.data, png.toString('base64'));
  assert.equal(validateAttachment(att).ok, true);
});

test('attach: a missing file degrades to a note instead of throwing', () => {
  const att = makeAttachment({ type: 'image', mediaType: 'image/png', path: join(tmp(), 'gone.png'), bytes: 10, tokens: 1 });
  const r = materializeAttachment(att);
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer exists/);
  const { blocks, notes } = materializeAll([att]);
  assert.equal(blocks.length, 0);
  assert.match(notes[0], /unavailable/);
});

test('attach: oversize at request time is refused (the file changed after Read)', () => {
  const dir = tmp();
  const big = Buffer.concat([makePng(1, 1), Buffer.alloc(MAX_IMAGE_BYTES)]);
  const path = writeFixture(dir, 'big.png', big);
  const att = makeAttachment({ type: 'image', mediaType: 'image/png', path, bytes: 1, tokens: 1 });
  const r = materializeAttachment(att);
  assert.equal(r.ok, false);
  assert.match(r.error, /grew to/);
});

test('attach: labels describe the file and tokens sum across messages', () => {
  const att = makeAttachment({ type: 'image', mediaType: 'image/png', path: '/x/shot.png', bytes: 2048, tokens: 1200, width: 800, height: 600 });
  assert.equal(attachmentLabel(att), '[attached: shot.png (image/png, 800x600, 2.0 KB)]');
  const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x', attachments: [att] }] }];
  assert.equal(attachmentTokens(messages), 1200);
});

// --- vision gating -----------------------------------------------------------

test('vision: the catalog attachment flag decides, unknown models are allowed to try', () => {
  assert.equal(visionCapability({ model: VISION_MODEL, provider: 'deepinfra' }, {}).support, 'yes');
  assert.equal(visionCapability({ model: NO_VISION_MODEL, provider: 'deepinfra' }, {}).support, 'no');
  assert.equal(visionCapability({ model: 'totally-made-up-model', provider: 'deepinfra' }, {}).support, 'unknown');
  assert.equal(visionCapability({ model: VISION_MODEL }, {}).support, 'yes');
});

test('vision: COWCAT_VISION wins over the catalog in both directions', () => {
  assert.equal(visionOverride({ COWCAT_VISION: 'force' }), 'yes');
  assert.equal(visionOverride({ COWCAT_VISION: 'off' }), 'no');
  assert.equal(visionOverride({ COWCAT_VISION: 'nonsense' }), null);
  assert.equal(visionCapability({ model: NO_VISION_MODEL, provider: 'deepinfra' }, { COWCAT_VISION: 'force' }).support, 'yes');
  assert.equal(visionCapability({ model: VISION_MODEL, provider: 'deepinfra' }, { COWCAT_VISION: 'off' }).support, 'no');
});

test('vision: model lookup prefers the configured provider and needs no slash form', () => {
  const hit = lookupModel(VISION_MODEL, null);
  assert.equal(hit.model.attachment, true);
  assert.equal(lookupModel('', null), null);
  const slash = lookupModel(`deepinfra/${VISION_MODEL}`, null);
  assert.equal(slash.via, 'ref');
});

test('vision: refusal text names the model and both ways out', () => {
  const msg = visionRefusalMessage({ model: NO_VISION_MODEL, provider: 'deepinfra' }, { mediaKind: 'image' });
  assert.match(msg, /not marked as accepting image\/PDF input/);
  assert.match(msg, /\/model/);
  assert.match(msg, /COWCAT_VISION=force/);
});

test('vision: upstream error matching is narrow', () => {
  assert.equal(looksLikeVisionUnsupported('messages.1.content.0: unexpected `tool_use_id`'), false);
  assert.equal(looksLikeVisionUnsupported('invalid content block: image_url is not supported by this model'), true);
  assert.equal(looksLikeVisionUnsupported('this model does not support image input'), true);
  assert.equal(looksLikeVisionUnsupported('multimodal input is disabled for this deployment'), true);
  assert.equal(looksLikeVisionUnsupported('rate limit exceeded'), false);
});

// --- Read: images ------------------------------------------------------------

test('Read: an image comes back as a reference plus a header, not as bytes', () => {
  const dir = tmp();
  const png = makePng(120, 80);
  const path = writeFixture(dir, 'diagram.png', png);
  const ctx = ctxFor(dir, { model: VISION_MODEL, provider: 'deepinfra', protocol: 'openai' });
  const res = ReadTool.execute({ file_path: path }, ctx);

  assert.equal(res.ok, true);
  assert.match(res.output, /\[image\] diagram\.png — image\/png, 120x80/);
  assert.match(res.output, /attached for the model/);
  assert.equal(res.attachments.length, 1);
  const att = res.attachments[0];
  assert.equal(att.type, 'image');
  assert.equal(att.path, path);
  assert.equal(att.mediaType, 'image/png');
  assert.ok(att.tokens > 0);
  assert.equal(JSON.stringify(res).includes(png.toString('base64').slice(0, 24)), false, 'base64 must not leak into the tool result');
  assert.equal(ctx.readSet.has(path), true, 'reading an image registers it for later edits');
});

test('Read: the catalog flag refuses image input before the API call', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'a.png', makePng(4, 4));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: NO_VISION_MODEL, provider: 'deepinfra' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /not marked as accepting image\/PDF input/);
});

test('Read: COWCAT_VISION=force overrides a catalog refusal', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'a.png', makePng(4, 4));
  const prev = process.env.COWCAT_VISION;
  process.env.COWCAT_VISION = 'force';
  try {
    const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: NO_VISION_MODEL, provider: 'deepinfra' }));
    assert.equal(res.ok, true);
    assert.equal(res.attachments.length, 1);
  } finally {
    if (prev === undefined) delete process.env.COWCAT_VISION;
    else process.env.COWCAT_VISION = prev;
  }
});

test('Read: an unknown model is allowed through with a hint', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'a.png', makePng(4, 4));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: 'internal-vlm-9', provider: 'custom' }));
  assert.equal(res.ok, true);
  assert.match(res.output, /not in the model catalog/);
});

test('Read: an oversized image is refused with the limit in the message', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'huge.png', Buffer.concat([makePng(1, 1), Buffer.alloc(MAX_IMAGE_BYTES)]));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL, provider: 'deepinfra' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /limit for model image input is 5\.0 MB/);
});

test('Read: unsupported image formats tell the model what to do', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'shot.bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(64)]));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL }));
  assert.equal(res.ok, false);
  assert.match(res.error, /BMP image; only png, jpeg, gif and webp/);
});

test('Read: content wins over the extension, in both directions', () => {
  const dir = tmp();
  // text content behind an image name: readable as text (content wins)
  const fakePath = writeFixture(dir, 'notreally.png', Buffer.from('this is just text, honestly\n'));
  const fake = ReadTool.execute({ file_path: fakePath }, ctxFor(dir, { model: VISION_MODEL }));
  assert.equal(fake.ok, true);
  assert.match(fake.output, /1\tthis is just text, honestly/);

  // binary content behind an image name: refused, because it is neither a
  // recognizable image nor text
  const binPath = writeFixture(dir, 'archive.png', Buffer.from([0x00, 0x13, 0x37, 0xff, 0x00]));
  const bin = ReadTool.execute({ file_path: binPath }, ctxFor(dir, { model: VISION_MODEL }));
  assert.equal(bin.ok, false);
  assert.match(bin.error, /named like a PNG file but its content is not a recognizable one/);

  // a real image with no extension at all is still recognized as an image
  const imgPath = writeFixture(dir, 'screenshot', makePng(5, 5));
  const real = ReadTool.execute({ file_path: imgPath }, ctxFor(dir, { model: VISION_MODEL }));
  assert.equal(real.ok, true);
  assert.equal(real.attachments.length, 1);
  assert.equal(real.attachments[0].mediaType, 'image/png');
});

// --- Read: PDF ---------------------------------------------------------------

test('Read: a PDF on an Anthropic protocol becomes a document attachment', () => {
  const dir = tmp();
  const pdf = makePdf(['Large Language Models are useful for many tasks.', 'This second line exists to clear the extraction threshold.']);
  const path = writeFixture(dir, 'paper.pdf', pdf);
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL, provider: 'deepinfra', protocol: 'anthropic' }));
  assert.equal(res.ok, true);
  assert.match(res.output, /\[pdf\] paper\.pdf — application\/pdf, 1 page/);
  assert.equal(res.attachments.length, 1);
  assert.equal(res.attachments[0].type, 'document');
  assert.equal(res.attachments[0].mediaType, 'application/pdf');
  assert.ok(res.attachments[0].tokens > 0);
});

test('Read: a PDF on an OpenAI-compatible protocol is extracted to text', () => {
  const dir = tmp();
  const pdf = makePdf(['Large Language Models are useful for many tasks.', 'This second line exists to clear the extraction threshold.']);
  const path = writeFixture(dir, 'paper.pdf', pdf);
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL, provider: 'deepinfra', protocol: 'openai' }));
  assert.equal(res.ok, true);
  assert.match(res.output, /text extracted best-effort/);
  assert.match(res.output, /Large Language Models are useful for many tasks\./);
  assert.equal(res.attachments, undefined, 'an extracted PDF has no attachment to send');
});

test('Read: a PDF with no extractable text fails with guidance', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'scan.pdf', makePdf(['x']));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL, provider: 'deepinfra', protocol: 'openai' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /best-effort text extraction failed/);
  assert.match(res.error, /Convert the PDF to text first/);
});

test('Read: an oversized PDF is refused', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'big.pdf', Buffer.concat([makePdf(['hi']), Buffer.alloc(MAX_PDF_BYTES)]));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL, provider: 'deepinfra', protocol: 'anthropic' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /limit for model PDF input is 10\.0 MB/);
});

test('pdftext: inflates FlateDecode streams and reports quality failures', () => {
  const ok = extractPdfText(makePdf(['A sentence long enough to pass the extractor minimum length.']));
  assert.equal(ok.ok, true);
  assert.match(ok.text, /A sentence long enough/);

  const empty = extractPdfText(makePdf(['x']));
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /only 1 characters/);
});

// --- Read: notebooks ---------------------------------------------------------

test('Read: a notebook renders cells, outputs and an image-output note', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'analysis.ipynb', makeNotebookBuffer());
  const ctx = ctxFor(dir, { model: VISION_MODEL });
  const res = ReadTool.execute({ file_path: path }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.attachments, undefined, 'notebook images are not attached');
  assert.match(res.output, /\[notebook\] analysis\.ipynb — 2 cells \(1 markdown, 1 code\)/);
  assert.match(res.output, /--- cell \[0\] markdown ---\n1\t# Analysis/);
  assert.match(res.output, /--- cell \[1\] code exec:3 ---/);
  assert.match(res.output, /--- output \[1\.0\] stream ---\n1\thello from stdout/);
  assert.match(res.output, /\[image output: image\/png, .* — not attached/);
  assert.match(res.output, /--- output \[1\.2\] error ---\n1\tValueError: boom/);
  assert.match(res.output, /offset\/limit do not apply/);
  assert.equal(ctx.readSet.has(path), true);
});

test('Read: a .ipynb that is not notebook JSON is reported as such', () => {
  const dir = tmp();
  const path = writeFixture(dir, 'broken.ipynb', Buffer.from('{"cells": "nope"}\n'));
  const res = ReadTool.execute({ file_path: path }, ctxFor(dir, { model: VISION_MODEL }));
  assert.equal(res.ok, false);
  assert.match(res.error, /notebook has no "cells" array/);
});

// --- Read: the text path must not regress ------------------------------------

test('Read: text behavior is unchanged (paging, allow_large, binary)', () => {
  const dir = tmp();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const path = writeFixture(dir, 'many.txt', Buffer.from(lines));
  const ctx = ctxFor(dir, { model: VISION_MODEL });

  const page = ReadTool.execute({ file_path: path, offset: 5, limit: 3 }, ctx);
  assert.match(page.output, /^5\tline 5\n6\tline 6\n7\tline 7/);
  assert.match(page.output, /\[showing lines 5-7 of 30\]/);
  assert.equal(page.attachments, undefined);

  const whole = ReadTool.execute({ file_path: path, allow_large: true }, ctx);
  assert.match(whole.output, /^1\tline 1/);

  const bad = writeFixture(dir, 'blob.bin', Buffer.from([0x00, 0xff, 0x10]));
  const binary = ReadTool.execute({ file_path: bad }, ctx);
  assert.equal(binary.ok, false);
  assert.equal(binary.error, 'Binary file, not readable as text');

  const missing = ReadTool.execute({ file_path: join(dir, 'nope.txt') }, ctx);
  assert.match(missing.error, /File not found/);
});

// --- notebook renderer (direct) ---------------------------------------------

test('renderNotebook: per-cell line numbering and output truncation', () => {
  const nb = parseNotebook(makeNotebookBuffer().toString('utf8')).nb;
  const rendered = renderNotebook(nb, { path: '/x/analysis.ipynb', maxOutputChars: 12 });
  assert.match(rendered, /--- output \[1\.0\] stream ---/);
  const code = parseNotebook('{"cells":[{"cell_type":"code","source":"a\\nb\\nc"}],"nbformat":4,"nbformat_minor":5}').nb;
  assert.match(renderNotebook(code), /1\ta\n2\tb\n3\tc/);
});
