// W1 Task 1: grapheme-aware width measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { graphemes, charWidth, stringWidth, sliceWidth } from '../src/tui/wcwidth.js';

test('wcwidth: stringWidth handles ASCII, CJK, emoji, combining marks, braille', () => {
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('中文'), 4);
  assert.equal(stringWidth('a👍b'), 4);
  assert.equal(stringWidth('👨‍👩‍👧'), 2, 'family is a single grapheme cluster');
  assert.equal(stringWidth('e\u0301'), 1, 'combining mark adds no width');
  assert.equal(stringWidth('⠋'), 1, 'braille is narrow');
});

test('wcwidth: graphemes splits clusters and charWidth classifies', () => {
  assert.deepEqual(graphemes('a👍b'), ['a', '👍', 'b']);
  assert.equal(graphemes('👨‍👩‍👧').length, 1);
  assert.equal(charWidth('中'), 2);
  assert.equal(charWidth('a'), 1);
});

test('wcwidth: sliceWidth cuts by width without splitting wide chars', () => {
  assert.deepEqual(sliceWidth('中文x', 3), { text: '中文', rest: 'x' });
  assert.deepEqual(sliceWidth('中文x', 2), { text: '中', rest: '文x' });
  assert.deepEqual(sliceWidth('ab', 5), { text: 'ab', rest: '' });
});
