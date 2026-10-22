import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPILL_HEAD_BYTES, SPILL_MAX_INLINE_BYTES, spillOutput } from '../src/index.js';

/**
 * ADR-119: oversized tool results spill to the session directory and travel as a
 * reference plus a head, never as the whole text.
 */

function tempRoot(t: import('node:test').TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'cowcat-spill-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('a small output travels whole and writes nothing', (t) => {
  const root = tempRoot(t);
  const outcome = spillOutput({ rootDir: root }, 'sess_a', 'call_1', 'small', 100);
  assert.equal(outcome.output, 'small');
  assert.equal(outcome.spilledTo, null);
});

test('an oversized output is written whole and travels as reference plus head', (t) => {
  const root = tempRoot(t);
  const full = `${'x'.repeat(10_000)}END`;
  const outcome = spillOutput({ rootDir: root }, 'sess_a', 'call_1', full, 1_000);

  assert.equal(outcome.spilledTo, join(root, 'sess_a', 'spill', 'call_1.txt'));
  assert.equal(readFileSync(join(root, 'sess_a', 'spill', 'call_1.txt'), 'utf8'), full);
  assert.match(outcome.output, /^\[spilled: full output of 10003 bytes written to /);
  assert.ok(outcome.output.includes('first 4096 bytes below'));
  assert.ok(outcome.output.endsWith('x'.repeat(SPILL_HEAD_BYTES)));
});

test('the head never tears a multi-byte sequence', (t) => {
  const root = tempRoot(t);
  // Every character is 3 bytes in UTF-8; a naive byte slice would land mid-sequence.
  const full = '中'.repeat(2_000);
  const outcome = spillOutput({ rootDir: root }, 'sess_b', 'call_2', full, 100);
  const head = outcome.output.slice(outcome.output.indexOf('\n') + 1);
  assert.equal(head, '中'.repeat(Math.floor(SPILL_HEAD_BYTES / 3)));
  assert.ok(!head.includes('�'));
});

test('the default threshold is the ADR value and is byte-based, not character-based', (t) => {
  const root = tempRoot(t);
  // 20k Chinese characters = 60KB: over the 50KB byte threshold, under any character count.
  const full = '字'.repeat(20_000);
  const outcome = spillOutput({ rootDir: root }, 'sess_c', 'call_3', full);
  assert.equal(outcome.spilledTo !== null, true);
  assert.equal(SPILL_MAX_INLINE_BYTES, 50_000);
});

test('a disk failure falls back to the whole output rather than failing the call', (t) => {
  // A rootDir that cannot be created: the sessions dir segment collides with a file.
  const root = tempRoot(t);
  const blocked = join(root, 'blocker');
  writeFileSync(blocked, 'occupied');
  const full = 'y'.repeat(2_000);
  const outcome = spillOutput({ rootDir: blocked }, 'sess_d', 'call_4', full, 100);
  assert.equal(outcome.output, full);
  assert.equal(outcome.spilledTo, null);
});
