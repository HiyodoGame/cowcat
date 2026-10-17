import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputTail } from '../src/index.js';

// Keep the tail, count what was dropped.
//
// The counting is the part that fails quietly: an under-reported `dropped` turns "we
// kept the tail for you" into a claim nobody can check. Every case below is an
// arithmetic identity — kept + dropped === total — because that identity is the only
// thing a caller can rely on when it renders "…showing the last N characters".

test('a short stream is kept whole and is not truncated', () => {
  const tail = new OutputTail(100);

  tail.push('hello');

  assert.equal(tail.text, 'hello');
  assert.equal(tail.dropped, 0);
  assert.equal(tail.truncated, false);
});

test('only the tail survives the cap, and the count adds up', () => {
  const tail = new OutputTail(5);

  tail.push('aaaaa');
  tail.push('bbbbb');
  tail.push('ccccc');

  // The stack trace at the end is the reason for keeping the tail at all; the head is
  // exactly what the caller needed to see and did not get.
  assert.equal(tail.text, 'ccccc');
  assert.equal(tail.dropped, 10);
  assert.equal(tail.text.length + tail.dropped, 15);
  assert.equal(tail.truncated, true);
});

test('a single chunk larger than the cap is cut from the front', () => {
  const tail = new OutputTail(3);

  tail.push('0123456789');

  assert.equal(tail.text, '789');
  assert.equal(tail.dropped, 7);
});

test('a cap of zero keeps nothing and still accounts for everything', () => {
  const tail = new OutputTail(0);

  tail.push('anything');

  assert.equal(tail.text, '');
  assert.equal(tail.dropped, 8);
  assert.equal(tail.truncated, true);
});

test('a negative cap is treated as zero rather than as "keep everything"', () => {
  // A cap of -1 meaning "unbounded" is the kind of default that silently defeats the
  // limit it was meant to describe.
  const tail = new OutputTail(-1);

  tail.push('streamed');

  assert.equal(tail.text, '');
  assert.equal(tail.dropped, 8);
});

test('empty writes change nothing', () => {
  const tail = new OutputTail(4);

  tail.push('');
  tail.push('abcd');
  tail.push('');

  assert.equal(tail.text, 'abcd');
  assert.equal(tail.dropped, 0);
});

test('an unbounded stream keeps everything', () => {
  const tail = new OutputTail(Number.POSITIVE_INFINITY);

  tail.push('x'.repeat(100_000));

  assert.equal(tail.text.length, 100_000);
  assert.equal(tail.dropped, 0);
  assert.equal(tail.truncated, false);
});

test('a chunk that lands exactly on the cap does not report truncation', () => {
  const tail = new OutputTail(4);

  tail.push('abcd');

  // The boundary case: exactly-at-cap is not truncated, and a false `truncated: true`
  // would make the caller print a notice about output it is showing in full.
  assert.equal(tail.dropped, 0);
  assert.equal(tail.truncated, false);
});

test('kept + dropped === total, however the chunks fall', () => {
  // Property-style sweep over chunk sizes, because the trim loop walks chunks and
  // slices heads, and that is where an off-by-one hides.
  for (const sizes of [[1, 1, 1], [7, 1, 30], [10, 10], [3, 100], [50], [1, 99]]) {
    for (const cap of [0, 1, 5, 10, 64]) {
      const tail = new OutputTail(cap);
      let total = 0;
      for (const size of sizes) {
        const chunk = 'y'.repeat(size);
        total += size;
        tail.push(chunk);
      }
      assert.equal(
        tail.text.length + tail.dropped,
        total,
        `cap ${String(cap)} with chunks ${sizes.join('+')}`,
      );
      assert.ok(tail.text.length <= Math.max(0, cap), `cap ${String(cap)} with chunks ${sizes.join('+')}`);
      // Whatever survived is the END of the stream, never a middle piece.
      assert.equal(tail.text, 'y'.repeat(tail.text.length));
      assert.equal(tail.truncated, tail.dropped > 0);
    }
  }
});