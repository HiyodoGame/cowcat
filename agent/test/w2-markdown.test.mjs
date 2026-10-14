// W2 Task 6: streaming markdown block renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getTheme } from '../src/tui/theme.js';
import { stringWidth } from '../src/tui/wcwidth.js';
import { createMarkdownRenderer } from '../src/tui/markdown.js';

const theme = getTheme('dark', '256');
const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

const plain = (rows) => rows.map((r) => stripAnsi(r.text));

test('markdown: h1 renders bold+italic+underline followed by a blank row', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('# Title\n');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].text.includes('\x1b[1m'));
  assert.ok(rows[0].text.includes('\x1b[3m'));
  assert.ok(rows[0].text.includes('\x1b[4m'));
  assert.equal(stripAnsi(rows[0].text), 'Title');
  assert.equal(rows[0].width, stringWidth('Title'));
  assert.deepEqual(rows[1], { text: '', width: 0 });
});

test('markdown: h2+ renders bold only', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('## Sub\n');
  assert.ok(rows[0].text.includes('\x1b[1m'));
  assert.ok(!rows[0].text.includes('\x1b[3m'));
  assert.equal(stripAnsi(rows[0].text), 'Sub');
});

test('markdown: nested ul indents 2 spaces and uses letter markers at level 2', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('- a\n  - b\n');
  assert.deepEqual(plain(rows), ['- a', '  a. b']);
});

test('markdown: ordered lists keep source numbers', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('1. one\n2. two\n');
  assert.deepEqual(plain(rows), ['1. one', '2. two']);
});

test('markdown: quote renders dim+italic inactive text', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('> quoted text\n');
  assert.deepEqual(plain(rows), ['quoted text']);
  assert.ok(rows[0].text.includes(theme.inactive));
  assert.ok(rows[0].text.includes('\x1b[2m'));
  assert.ok(rows[0].text.includes('\x1b[3m'));
});

test('markdown: fenced code goes through the highlight callback line by line', () => {
  const calls = [];
  const r = createMarkdownRenderer({
    theme, width: 80,
    highlight: (code, lang) => { calls.push([code, lang]); return code.toUpperCase(); },
  });
  const rows = r.push('```js\nconst x=1\n```\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'CONST X=1');
  assert.equal(rows[0].width, 9);
  assert.deepEqual(calls.at(-1), ['const x=1', 'js']);
});

test('markdown: unclosed fence renders received code lines immediately', () => {
  const r = createMarkdownRenderer({
    theme, width: 80,
    highlight: (c) => c.toUpperCase(),
  });
  const rows = r.push('```js\nconst');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'CONST');
});

test('markdown: unclosed fence grows as more code arrives, replacing prior rows', () => {
  const r = createMarkdownRenderer({
    theme, width: 80,
    highlight: (c) => c.toUpperCase(),
  });
  r.push('```\nabc');
  const rows = r.push(' def');
  assert.deepEqual(plain(rows), ['ABC DEF']);
});

test('markdown: inline bold/italic/code/link tokenize and style spans', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('a **bold** *it* `c` [l](http://x)\n');
  assert.deepEqual(plain(rows), ['a bold it c l (http://x)']);
  assert.ok(rows[0].text.includes('\x1b[1mbold'));
  assert.ok(rows[0].text.includes('\x1b[3mit'));
  assert.ok(rows[0].text.includes(theme.permission + 'c'));
  assert.ok(rows[0].text.includes('\x1b[2ml (http://x)'));
});

test('markdown: osc8 true emits OSC8 hyperlink sequences and hides the url', () => {
  const r = createMarkdownRenderer({ theme, width: 80, osc8: true });
  const rows = r.push('**b** [click](http://x)\n');
  assert.deepEqual(plain(rows), ['b click']);
  assert.ok(rows[0].text.includes('\x1b]8;;http://x\x1b\\'));
  assert.ok(rows[0].text.includes(theme.permission));
});

test('markdown: osc8 link wraps with escapes as zero-width units (no split inside a sequence)', () => {
  const r = createMarkdownRenderer({ theme, width: 10, osc8: true });
  const rows = r.push('a *b* [click here now](http://example.com)\n');
  assert.ok(rows.length > 1, 'long link wraps across rows');
  const joined = rows.map((row) => row.text).join('');
  assert.equal(
    joined.replace(/ /g, ''),
    `a \x1b[3mb\x1b[0m \x1b]8;;http://example.com\x1b\\${theme.permission}click here now\x1b[0m\x1b]8;;\x1b\\`.replace(/ /g, ''),
    'concatenated rows reproduce the full span — no escape sequence was truncated by a break',
  );
  for (const row of rows) {
    assert.ok(row.width <= 10, `visible width within budget: ${row.width}`);
    assert.ok(!/\x1b]8[^\x1b]*$/.test(row.text) && !/\x1b$/.test(row.text), 'no row ends mid-escape');
  }
});

test('markdown: chunk split mid-bold re-renders the word exactly once', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const first = r.push('**bo');
  assert.deepEqual(plain(first), ['**bo']);
  const rows = r.push('ld**');
  assert.equal(rows.length, 1);
  assert.equal(stripAnsi(rows[0].text), 'bold');
  assert.ok(rows[0].text.includes('\x1b[1m'));
  assert.equal(rows[0].text.split('bold').length - 1, 1);
});

test('markdown: table aligns columns by measured width incl. CJK, min col width 3', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('| 名称 | 值 |\n| --- | --- |\n| 中文 | 1 |\n');
  assert.deepEqual(plain(rows), [
    '| 名称 | 值  |',
    '|------|-----|',
    '| 中文 | 1   |',
  ]);
  for (const row of rows) assert.equal(row.width, 14);
});

test('markdown: plain fast path wraps without any SGR for 200+ meta-free chars', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const rows = r.push('a'.repeat(300) + '\n');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => !row.text.includes('\x1b')));
  assert.equal(rows.map((row) => stripAnsi(row.text)).join(''), 'a'.repeat(300));
});

test('markdown: fast→full transition replays closed rows once with supersedes set', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const first = r.push('hello\n');
  assert.deepEqual(plain(first), ['hello']);
  const rows = r.push('# T\n');
  assert.equal(rows.supersedes, true, 'transition push supersedes fast-path rows');
  assert.deepEqual(plain(rows), ['hello', 'T', ''], 'fast row replayed by the closed section, not appended by the caller');
  const heading = rows.find((row) => stripAnsi(row.text) === 'T');
  assert.ok(heading.text.includes('\x1b[4m'));
});

test('markdown: opener paragraph followed by a heading is not lost on fast→full switch (regression)', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const first = r.push('Sure, here you go.\n\n');
  assert.deepEqual(plain(first), ['Sure, here you go.']);
  const rows = r.push('# Steps\n\n1. one\n');
  assert.equal(rows.supersedes, true);
  assert.deepEqual(plain(rows), ['Sure, here you go.', 'Steps', '', '1. one'], 'heading rows kept, list tail present');
});

test('markdown: CJK paragraph wraps at width without splitting words', () => {
  const r = createMarkdownRenderer({ theme, width: 10 });
  const rows = r.push('这是一个中文段落用于测试折行功能\n');
  assert.deepEqual(plain(rows), ['这是一个中', '文段落用于', '测试折行功', '能']);
  assert.ok(rows.every((row) => row.width <= 10));
});

test('markdown: latin paragraph breaks at spaces instead of mid-word', () => {
  const r = createMarkdownRenderer({ theme, width: 8 });
  const rows = r.push('hello world foo\n');
  assert.deepEqual(plain(rows), ['hello', 'world', 'foo']);
});

test('markdown: hr renders as a single full-width subtle rule', () => {
  const r = createMarkdownRenderer({ theme, width: 10 });
  const rows = r.push('---\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].width, 10);
  assert.ok(rows[0].text.includes(theme.subtle));
  assert.ok(!stripAnsi(rows[0].text).includes('-'));
});

test('markdown: reset clears state and applies a new width', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  r.push('# A\n');
  r.reset(20);
  const rows = r.push('plain words here ok\n');
  assert.deepEqual(plain(rows), ['plain words here ok']);
  assert.ok(!rows[0].text.includes('\x1b['));
});

test('markdown: push returns closed lines once and full re-render of the open tail', () => {
  const r = createMarkdownRenderer({ theme, width: 80 });
  const first = r.push('# A\n\ntail');
  assert.deepEqual(plain(first), ['A', '', 'tail']);
  const second = r.push(' end\n');
  assert.deepEqual(plain(second), ['tail end'], 'closed heading rows are not repeated');
});
