import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrap } from '../src/text/wrap.js';
import { stringWidth } from '../src/text/width.js';

/** Breaks at a space past a third of the line, keeping the ragged edge readable. */
test('wrap breaks at spaces near the end of the line', () => {
  assert.deepEqual(wrap('hello world foo', 11), ['hello', 'world foo']);
  // A space in the first third is ignored: a long word is split instead.
  assert.deepEqual(wrap('aa bbbbbbbb', 6), ['aa bbb', 'bbbbb']);
});

test('wrap splits words longer than the line and never returns a too-wide row', () => {
  assert.deepEqual(wrap('aaaaaaaaaaaa', 5), ['aaaaa', 'aaaaa', 'aa']);
  for (const row of wrap('把把把把把把', 5)) assert.equal(stringWidth(row), 4);
});

test('wrap keeps logical lines apart and passes short ones through', () => {
  assert.deepEqual(wrap('ab\ncd', 10), ['ab', 'cd']);
  assert.deepEqual(wrap('', 10), ['']);
});

test('wrap never cuts through a grapheme cluster', () => {
  // 'a\u0301' is base + combining mark: two UTF-16 units, one cluster, one cell. The break
  // lands on the middle space cluster, and the mark must travel with its base. (Written in
  // escapes on purpose: the precomposed á would make the space sit at UTF-16 index 1 and
  // exercise a different break.)
  const marked = 'a\u0301 a\u0301 a\u0301';
  const rows = wrap(marked, 3);
  assert.deepEqual(rows, ['a\u0301', 'a\u0301 a\u0301']);
  for (const row of rows) assert.ok(!row.startsWith('\u0301'), 'the mark stays on its base');
});

test('a cluster wider than the line is emitted alone instead of looping forever', () => {
  // Regression: with width 1 and two-cell graphemes the slice-based version never advanced.
  assert.deepEqual(wrap('把把', 1), ['把', '把']);
});

test('a space carrying combining marks falls back to re-segmenting the remainder', () => {
  // The space + mark form one cluster, so the space break lands inside it; the fallback must
  // still produce rows that join back to the unwrapped remainder.
  const text = 'aaaa \u0301bbbb';
  const rows = wrap(text, 6);
  assert.ok(rows.length > 1);
  assert.equal(rows.join(''), 'aaaa\u0301bbbb');
});
