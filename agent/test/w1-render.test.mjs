// W1 Task 4: wcwidth-based measurement, ansiStateCarry, screen frame diff,
// per-entry render cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  visibleLen, truncateAnsi, padLine, wrapText, stripFirstChars, ansiStateCarry,
} from '../src/tui/render.js';
import { Screen } from '../src/tui/screen.js';
import { TuiUI } from '../src/tui/ui.js';

test('render: visibleLen/truncateAnsi measure display width, not code units', () => {
  assert.equal(visibleLen('中\x1b[31m文\x1b[0m'), 4);
  const cut = truncateAnsi('中文文', 3);
  assert.equal(cut.replace(/\x1b\[[0-9;]*m/g, ''), '中文', 'fill semantics: 2 hanzi, no more no less');
  assert.equal(visibleLen(cut), 4, 'one column of fill overflow accepted');
  assert.equal(visibleLen(truncateAnsi('中文文', 6)), 6, 'fits exactly -> untouched');
});

test('render: ansiStateCarry extracts still-active SGR state', () => {
  assert.equal(ansiStateCarry('\x1b[31mabc'), '\x1b[31m');
  assert.equal(ansiStateCarry('\x1b[1m\x1b[31mabc'), '\x1b[1;31m');
  assert.equal(ansiStateCarry('\x1b[31mabc\x1b[0m'), '');
  assert.equal(ansiStateCarry('\x1b[31mabc\x1b[39m'), '', 'fg reset cancels red');
  assert.equal(ansiStateCarry('\x1b[31mabc\x1b[39m\x1b[1m'), '\x1b[1m');
  assert.equal(ansiStateCarry('plain'), '');
});

test('render: wrapText carries ANSI style across wrapped lines', () => {
  const wrapped = wrapText('\x1b[31mhello world\x1b[0m', 8);
  assert.equal(wrapped.length, 2);
  assert.ok(wrapped[0].startsWith('\x1b[31m'));
  assert.ok(wrapped[1].startsWith('\x1b[31m'), 'continuation re-opens red via ansiStateCarry');
  assert.ok(wrapped[1].includes('\x1b[0m'));
  assert.equal(wrapped.map((l) => visibleLen(l)).join(','), '5,5');
});

test('render: wrapText breaks at spaces and hard-cuts CJK by column', () => {
  const words = wrapText('one two three', 9);
  assert.deepEqual(words.map((l) => visibleLen(l)), [7, 5]);
  assert.deepEqual(wrapText('中文文', 3).map((l) => visibleLen(l)), [2, 2, 2]);
  assert.deepEqual(wrapText('a\nb', 80), ['a', 'b']);
});

test('render: padLine/stripFirstChars are width-aware', () => {
  assert.equal(visibleLen(padLine('中文', 6)), 6);
  const stripped = stripFirstChars('\x1b[32mabcdef\x1b[0m', 2);
  assert.equal(visibleLen(stripped), 4);
  assert.equal(stripFirstChars('中文文', 2), '文文');
});

function fakeScreen() {
  const chunks = [];
  const out = { write: (s) => chunks.push(s), columns: 80, rows: 24 };
  const scr = new Screen({ input: { on: () => {}, off: () => {}, once: () => {}, setRawMode: () => {} }, output: out });
  scr.enter();
  return { scr, chunks, last: () => chunks[chunks.length - 1] };
}

test('screen: draw diffs against lastLines, skipping unchanged rows', () => {
  const { scr, last } = fakeScreen();
  scr.draw(['a', 'b']);
  assert.deepEqual(scr.lastLines, ['a', 'b']);
  scr.draw(['a', 'c']);
  const second = last();
  assert.ok(!second.includes('a\n') && !/a$/.test(second), 'unchanged row a is not rewritten');
  assert.ok(second.includes('c'), 'changed row c is written');
  assert.ok(second.includes('\x1b['), 'cursor repositioned with CSI');
  scr.draw(['a']);
  assert.ok(last().includes('\x1b[J'), 'shorter frame clears the tail');
  scr.leave();
});

test('screen: identical frame writes nothing', () => {
  const { scr, chunks } = fakeScreen();
  scr.draw(['x', 'y']);
  const n = chunks.length;
  scr.draw(['x', 'y']);
  assert.equal(chunks.length, n, 'no output for an unchanged frame');
  scr.leave();
});

function headlessTui() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: false, version: '0.9.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
  });
  return tui;
}

test('tui: materialize caches per entry and recomputes on width change', () => {
  const tui = headlessTui();
  const entry = { kind: 'text', lines: ['hello world'], _rendered: null };
  const r1 = tui._materialize(entry, 100);
  const r2 = tui._materialize(entry, 100);
  assert.equal(r1, r2, 'same width -> same array reference');
  const r3 = tui._materialize(entry, 40);
  assert.notEqual(r3, r1, 'width change -> recompute');
  tui.close();
});

test('tui: stream growth invalidates only the growing entry', () => {
  const tui = headlessTui();
  const a = { kind: 'text', lines: ['alpha'], _rendered: null };
  const b = { kind: 'stream', lines: [''], _rendered: null };
  tui.entries.push(a, b);
  const ra = tui._materialize(a, 100);
  tui._materialize(b, 100);
  b.lines[b.lines.length - 1] += 'chunk';
  b._rendered = null;
  assert.equal(tui._materialize(a, 100), ra, 'untouched entry keeps its cache');
  assert.notEqual(tui._materialize(b, 100).join('').includes('chunk'), false);
  tui.close();
});
