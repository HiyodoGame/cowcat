import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeLineDiff, foldItems, unifiedDiff } from '../src/text/diff.js';

/**
 * The diff a `tool-card` shows for an `Edit`, ported from v1 (`agent/src/diffcard.js`).
 *
 * The assertions are about the things a reader checks when they look at a diff: is the line
 * count right, does the hunk header match what is on screen, and does an unchanged file
 * produce nothing at all.
 */
test('a one-line change is one removal, one addition, and its context', () => {
  const ops = computeLineDiff(['a', 'b', 'c'], ['a', 'B', 'c']);
  assert.deepEqual(ops, [
    { sign: ' ', text: 'a' },
    { sign: '-', text: 'b' },
    { sign: '+', text: 'B' },
    { sign: ' ', text: 'c' },
  ]);
});

test('an unchanged pair produces no hunk at all', () => {
  const diff = unifiedDiff('same\nlines\n', 'same\nlines\n');
  assert.deepEqual(diff.items, []);
  assert.deepEqual({ added: diff.added, removed: diff.removed }, { added: 0, removed: 0 });
});

test('hunks carry the right header, and the counts are the whole file', () => {
  const oldText = Array.from({ length: 20 }, (_value, index) => `line ${String(index + 1)}`).join('\n');
  const newText = oldText.replace('line 10', 'line ten');
  const diff = unifiedDiff(oldText, newText);

  const headers = diff.items.filter((item) => item.kind === 'hunk').map((item) => item.header);
  // Two lines of context on each side of the one changed line.
  assert.deepEqual(headers, ['@@ -8,5 +8,5 @@']);
  assert.deepEqual({ added: diff.added, removed: diff.removed }, { added: 1, removed: 1 });
  // Only the hunk is emitted; the other fifteen unchanged lines are not. Six lines: two of
  // context, the removed one, the added one, two more of context.
  assert.equal(diff.items.filter((item) => item.kind === 'line').length, 6);
});

test('two changes far apart become two hunks; near ones merge', () => {
  const base = Array.from({ length: 30 }, (_value, index) => `line ${String(index + 1)}`);

  const far = unifiedDiff(base.join('\n'), base.map((line) => (line === 'line 3' || line === 'line 25' ? `${line}!` : line)).join('\n'));
  assert.equal(far.items.filter((item) => item.kind === 'hunk').length, 2);

  const near = unifiedDiff(base.join('\n'), base.map((line) => (line === 'line 3' || line === 'line 6' ? `${line}!` : line)).join('\n'));
  assert.equal(near.items.filter((item) => item.kind === 'hunk').length, 1);
});

test('an added line has no old number, a removed one has no new number', () => {
  const diff = unifiedDiff('a\nb\n', 'a\nnew\nb\n');
  const added = diff.items.find((item) => item.kind === 'line' && item.sign === '+');
  assert.deepEqual(added, { kind: 'line', sign: '+', text: 'new', oldNo: null, newNo: 2 });
});

test('a diff too large for the table degrades to "everything changed"', () => {
  // 2100 × 2100 cells is over the cap, so the LCS is abandoned rather than allocated.
  const big = Array.from({ length: 2_100 }, (_value, index) => `l${String(index)}`);
  const other = big.map((line) => `${line}!`);
  const ops = computeLineDiff(big, other);
  assert.equal(ops.filter((op) => op.sign === '-').length, 2_100);
  assert.equal(ops.filter((op) => op.sign === '+').length, 2_100);
  assert.equal(ops.filter((op) => op.sign === ' ').length, 0);
});

test('folding keeps the head and the tail and says what it hid', () => {
  const items = unifiedDiff(
    Array.from({ length: 40 }, (_value, index) => `old ${String(index)}`).join('\n'),
    Array.from({ length: 40 }, (_value, index) => `new ${String(index)}`).join('\n'),
  ).items;
  const folded = foldItems(items, 12);
  assert.equal(folded.items.length, 12);
  assert.ok(folded.collapsed > 0);
  assert.match(folded.items.map((item) => item.kind === 'line' ? item.text : item.header).join('\n'), /行折叠/);

  // Under the cap, nothing is touched.
  const small = foldItems(items.slice(0, 5), 12);
  assert.equal(small.collapsed, 0);
  assert.deepEqual(small.items, items.slice(0, 5));
});
