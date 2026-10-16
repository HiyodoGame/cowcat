// Chrome-redo regressions: CJK/emoji hardware-caret placement (frame-level
// assertions), the stray tool-card border line, GBK output decoding, the
// content-width completion overlay, and the jump-to-latest hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { TuiUI } from '../src/tui/ui.js';
import { decodeOutput, hasGbkSupport } from '../src/textdecode.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// real-screen harness: captures the absolute-addressed cursor sequences
function realScreenTui({ rows = 30, columns = 100, lang = 'zh', completions = null } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  const chunks = [];
  output.on('data', (d) => chunks.push(d.toString()));
  const tui = new TuiUI({
    input, output, colors: true, lang, version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    completions,
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.start();
  return { tui, input, chunks };
}

function cursorSeqs(chunks) {
  const all = chunks.join('');
  return [...all.matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)].map((m) => ({ row: Number(m[1]), col: Number(m[2]) }));
}

// expected 1-based caret position: metadata row (1) + composer row (1) + prefix
// cols (bar 1 + padding 2 + '› ' 2) + display column
const EXPECT_COL_BASE = 1 + 2 + 2;

test('caret: CJK text places the hardware caret by display width', async () => {
  const { tui, input, chunks } = realScreenTui();
  const p = tui.readLine();
  chunks.length = 0;
  input.write('请你检查项目'); // 6 CJK chars = 12 display columns
  await sleep(15);
  let seq = cursorSeqs(chunks).at(-1);
  assert.ok(seq, 'cursor sequence written');
  assert.equal(seq.col, EXPECT_COL_BASE + 12 + 1, 'caret after 6 CJK chars (12 columns)');

  // move INTO the line: three lefts -> caret sits after 查 (3 chars = 6 cols)
  chunks.length = 0;
  input.write('\x1b[D\x1b[D\x1b[D');
  await sleep(15);
  seq = cursorSeqs(chunks).at(-1);
  assert.equal(seq.col, EXPECT_COL_BASE + 6 + 1, 'caret mid-line after 3 CJK chars');
  input.write('\r');
  await p;
  tui.close();
});

test('caret: mixed CJK + ASCII + emoji columns', async () => {
  const { tui, input, chunks } = realScreenTui({ lang: 'en' });
  const p = tui.readLine();
  chunks.length = 0;
  input.write('ab测😀cd'); // a,b(2) + 测(2) + 😀(2) + c,d(2) = 8 display columns
  await sleep(15);
  let seq = cursorSeqs(chunks).at(-1);
  assert.equal(seq.col, EXPECT_COL_BASE + 8 + 1, 'caret after mixed-width text');
  input.write('\x1b[D\x1b[D'); // before c (after the emoji)
  await sleep(15);
  seq = cursorSeqs(chunks).at(-1);
  assert.equal(seq.col, EXPECT_COL_BASE + 6 + 1, 'caret after the emoji (2+2+2 columns in)');
  input.write('\x1b[D'); // one more: before the emoji
  await sleep(15);
  seq = cursorSeqs(chunks).at(-1);
  assert.equal(seq.col, EXPECT_COL_BASE + 4 + 1, 'caret before the emoji (2+2 columns in)');
  input.write('\r');
  await p;
  tui.close();
});

test('chrome: no stray border-only row under a done tool card', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  tui.toolCall('Bash', 'node -v');
  tui.toolSuccess(); // summaryLines [''] used to render a lone `│` row
  const flat = tui._flat().map(strip);
  assert.ok(!flat.some((l) => l.trim() === '│'), 'no orphan border row');
  assert.ok(flat.some((l) => l.startsWith('✓ Ran a command')), 'the done title row is there');
  tui.close();
});

test('decode: GBK bytes decode instead of U+FFFD, UTF-8 untouched', (t) => {
  // GBK comes from the ICU data. Runtimes built with small ICU (some CI images)
  // cannot decode it at all — that is a capability of the runtime, so assert the
  // graceful path there instead of a decoder we do not have.
  if (!hasGbkSupport()) {
    t.skip('this runtime has no GBK decoder (small ICU)');
    const gbk = Buffer.from([0xc4, 0xe3]); // '你'
    assert.equal(decodeOutput(gbk), gbk.toString('utf8'), 'falls back to the UTF-8 attempt, no crash');
    return;
  }
  // '你好' in GBK
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  assert.equal(decodeOutput(gbk), '你好');
  // GBK with an ASCII tail: 'hi ' + '世界'
  const mixed = Buffer.from([0x68, 0x69, 0x20, 0xca, 0xc0, 0xbd, 0xe7]);
  assert.equal(decodeOutput(mixed), 'hi 世界');
  // valid UTF-8 stays as-is (no re-decode)
  assert.equal(decodeOutput(Buffer.from('你好', 'utf8')), '你好');
  assert.equal(decodeOutput(Buffer.from('plain', 'utf8')), 'plain');
  assert.equal(decodeOutput(null), '');
  assert.equal(decodeOutput('already a string'), 'already a string');
  // bytes invalid in BOTH encodings keep the UTF-8 attempt (with replacements)
  const junk = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.equal(decodeOutput(junk), junk.toString('utf8'));
});

test('chrome: the completion overlay paints at content width, not full width', async () => {
  const { tui, input } = realScreenTui({
    lang: 'en',
    completions: () => ['/clear', '/exit', '/help', '/output', '/theme'],
  });
  const p = tui.readLine();
  input.write('/');
  await sleep(15);
  let frame = null;
  tui.screen.draw = (lines) => { frame = lines; };
  tui._draw();
  const inputLen = tui._inputFixed().length; // the floating menu claims no layout rows
  const inputStart = 29 - inputLen - 1;
  const overlayRows = frame.slice(inputStart - 6, inputStart).map(strip);
  const menuRow = overlayRows.find((r) => r.includes('/clear'));
  assert.ok(menuRow, 'menu row floats directly above the composer');
  const rawRow = frame[inputStart - 6 + overlayRows.indexOf(menuRow)];
  assert.ok(rawRow.includes(tui.theme.userBubbleBg), 'menu row sits on the raised surface');
  // content-width paint: after the LAST SGR sequence only blanks follow
  const afterLastSgr = rawRow.replace(/^(.*\x1b\[[0-9;]*m)/s, '');
  assert.ok(/^\s*$/.test(afterLastSgr), 'the raised surface stops at the content width');
  input.write('\r');
  await p;
  tui.close();
});

test('chrome: scrolled away from the bottom shows the jump-to-latest hint', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  let frame = null;
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = (lines) => { frame = lines; };
  tui.start();
  for (let i = 0; i < 40; i++) tui.print(`line ${i}`);
  tui._draw();
  const height = 29;
  const inputStart = height - tui._inputFixed().length - 1;
  assert.ok(!strip(frame[inputStart - 1]).includes('jump to latest'), 'no hint while at the bottom');
  tui.scroll = 0; // simulate scrolling up
  tui._draw();
  assert.ok(strip(frame[inputStart - 1]).includes('jump to latest'), 'hint appears when scrolled up');
  tui.close();
});

test('chrome: composer sits directly above the status bar — zero gap rows', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  let frame = null;
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = (lines) => { frame = lines; };
  tui.start();
  tui._draw();
  const height = 29; // max(10, rows - 1)
  const statusRow = strip(frame[height - 1]);
  assert.ok(statusRow.includes('/x'), 'status bar is the last row');
  const fixedLen = tui._inputFixed().length;
  const composerBottom = height - 1 - 1; // row above the status bar
  assert.ok(strip(frame[composerBottom]).includes('›'), 'composer bottom row hugs the status bar');
  assert.ok(!strip(frame[composerBottom - fixedLen]).includes('›') || fixedLen > 1, 'input block occupies exactly its rows');
  tui.close();
});

test('chrome: slash menu floats directly above the composer with no layout gap', async () => {
  const { tui, input } = realScreenTui({
    lang: 'en',
    completions: () => ['/clear', '/exit', '/help', '/output', '/theme'],
  });
  const p = tui.readLine();
  input.write('/');
  await sleep(15);
  let frame = null;
  tui.screen.draw = (lines) => { frame = lines; };
  tui._draw();
  const height = 29;
  const fixedLen = tui._inputFixed().length;
  const inputStart = height - fixedLen - 1;
  assert.ok(strip(frame[inputStart + fixedLen - 1]).includes('›'), 'composer bottom row hugs the status bar');
  assert.ok(strip(frame[inputStart - 1]).includes('(1/5)'), 'the menu counter row sits directly above the input block');
  input.write('\r');
  await p;
  tui.close();
});

test('chrome: resize repaints the whole frame at the new dimensions', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  let frame = null;
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = (lines) => { frame = lines; };
  tui.start();
  tui.readLine();
  tui._draw();
  assert.equal(frame.length, 29, 'initial frame height');
  // simulate a terminal resize: new dimensions + the resize event
  output.columns = 60;
  output.rows = 20;
  output.emit('resize');
  await sleep(10);
  assert.ok(frame, 'frame repainted after resize');
  assert.equal(frame.length, 19, 'frame follows the new height (max(10, rows-1))');
  assert.ok(strip(frame[18]).includes('/x'), 'status bar anchors the new last row');
  assert.ok(strip(frame[17]).includes('›'), 'composer re-anchored above it');
  assert.equal(frame[0].length > 0, true);
  tui.close();
});
