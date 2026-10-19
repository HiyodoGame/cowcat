import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RANGES, charWidth, graphemes, padTo, sliceWidth, stringWidth, truncate } from '../src/text/width.js';

/**
 * The width table, and the defect it was ported from.
 *
 * v1 kept two range tables and binary-searched each; the second one was not sorted, so half
 * of the emoji in `2600-27BF` measured one cell and shifted everything after them. The fix
 * is one merged table, and these two tests are what keeps it merged: a table that is out of
 * order, or that overlaps itself, cannot be searched correctly at all.
 */
test('the range table is sorted and disjoint — the two properties a binary search needs', () => {
  let previousEnd = -1;
  for (const [start, end] of RANGES) {
    assert.ok(start > previousEnd, `range ${start.toString(16)} overlaps or touches the previous one`);
    assert.ok(start <= end, `range ${start.toString(16)}-${end.toString(16)} is inverted`);
    previousEnd = end;
  }
});

test('every double-width emoji in 2600-27BF measures two cells', () => {
  // The exact window v1's unsorted table lost. Checked as a sweep, not as three examples:
  // the bug was a search that missed *some* members, and a spot check is what missed it.
  for (let codePoint = 0x2600; codePoint <= 0x27bf; codePoint += 1) {
    assert.equal(charWidth(String.fromCodePoint(codePoint)), 2, `U+${codePoint.toString(16).toUpperCase()} should be two cells`);
  }
});

test('CJK, ASCII, combining marks and astral emoji', () => {
  // 把 and 改名成 are four wide characters (8 cells); the rest is "value" + "total" + three
  // spaces. Written as a sum of the parts rather than one number, so the arithmetic is
  // checkable by reading it.
  assert.equal(stringWidth('把 value 改名成 total'), 4 * 2 + 'value'.length + 'total'.length + 3);
  assert.equal(charWidth('a'), 1);
  assert.equal(charWidth('把'), 2);
  assert.equal(charWidth('🎉'), 2);
  // A combining mark takes no cell of its own, and the cluster that follows it is one cell.
  assert.equal(charWidth('\u0301'), 0);
  assert.equal(stringWidth('e\u0301'), 1);
  assert.equal(graphemes('e\u0301').length, 1);
});

test('slicing never cuts through a cluster', () => {
  const text = 'ab把cd';
  assert.deepEqual(sliceWidth(text, 4), { text: 'ab把', rest: 'cd' });
  // Asking for 3 stops before the wide character rather than splitting it.
  assert.deepEqual(sliceWidth(text, 3), { text: 'ab', rest: '把cd' });
  assert.deepEqual(sliceWidth(text, 0), { text: '', rest: text });
});

test('truncate spends part of the budget on the ellipsis', () => {
  assert.equal(truncate('abcdef', 6), 'abcdef');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(stringWidth(truncate('把把把把', 5)), 5);
  assert.equal(truncate('abcdef', 1), '…');
  assert.equal(truncate('abcdef', 0), '');
});

test('padTo lands on exactly the requested width, either way round', () => {
  assert.equal(padTo('ab', 4), 'ab  ');
  assert.equal(padTo('ab', 4, 'right'), '  ab');
  assert.equal(stringWidth(padTo('把把把', 4)), 4, 'a wide string is truncated, never padded past the width');
  assert.equal(padTo('把', 4, 'right'), '  把');
});
