// FrecencyStore: scoring buckets, MRU ordering, JSONL persistence format,
// and the draft slot (autosave + clean-exit clear).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FrecencyStore, frecencyScore, recencyFactor } from '../src/tui/frecency.js';

const NOW = Date.parse('2025-01-15T12:00:00Z');

test('frecency: recency factors step down by age bucket', () => {
  assert.equal(recencyFactor(NOW, NOW), 1, 'under an hour');
  assert.equal(recencyFactor(NOW - 2 * 3600_000, NOW), 0.7, 'under a day');
  assert.equal(recencyFactor(NOW - 2 * 86400_000, NOW), 0.4, 'under a week');
  assert.equal(recencyFactor(NOW - 30 * 86400_000, NOW), 0.2, 'older floor');
});

test('frecency: score is count times the recency factor', () => {
  assert.equal(frecencyScore(null, NOW), 0, 'unknown item scores zero');
  assert.equal(frecencyScore({ count: 3, last: NOW }, NOW), 3);
  assert.ok(Math.abs(frecencyScore({ count: 3, last: NOW - 2 * 86400_000 }, NOW) - 1.2) < 1e-9);
  assert.ok(Math.abs(frecencyScore({ count: 1, last: NOW - 2 * 86400_000 }, NOW) - 0.4) < 1e-9);
});

test('frecency: add counts uses and recent() orders MRU first', () => {
  const s = new FrecencyStore(null);
  s.add('alpha', NOW - 3 * 86400_000);
  s.add('beta', NOW - 3600_000);
  s.add('alpha', NOW); // reused: count 2, most recent
  assert.equal(s.item('alpha').count, 2);
  assert.deepEqual(s.recent(), ['alpha', 'beta']);
  assert.equal(s.score('alpha', NOW), 2);
  s.add('   ', NOW);
  assert.equal(s.items.size, 2, 'blank prompts are not stored');
});

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-frecency-'));
  return { dir, file: join(dir, 'prompt-history.jsonl') };
}

test('frecency: persists as JSONL history records and reloads them', () => {
  const { file } = tmpStore();
  const s = new FrecencyStore(file);
  s.add('fix the parser', NOW);
  s.add('fix the parser', NOW + 60_000); // merged, not duplicated
  s.add('review the diff', NOW + 120_000);

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { type: 'history', text: 'fix the parser', count: 2, last: NOW + 60_000 },
    { type: 'history', text: 'review the diff', count: 1, last: NOW + 120_000 },
  ], 'one JSONL record per unique prompt');

  const reloaded = new FrecencyStore(file);
  assert.equal(reloaded.item('fix the parser').count, 2, 'counts survive a reload');
  assert.deepEqual(reloaded.recent(), ['review the diff', 'fix the parser']);
});

test('frecency: malformed lines are skipped, not fatal', () => {
  const { file } = tmpStore();
  writeFileSync(file, '{"type":"history","text":"good","count":1,"last":5}\nnot json\n{"type":"mystery"}\n');
  const s = new FrecencyStore(file);
  assert.equal(s.item('good').count, 1);
  assert.equal(s.items.size, 1);
});

test('frecency: draft slot autosaves and clearDraft removes it from disk', () => {
  const { file } = tmpStore();
  const s = new FrecencyStore(file);
  s.add('submitted prompt', NOW);
  s.saveDraft('a substantially long draft in progress');
  let parsed = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(parsed.at(-1), { type: 'draft', text: 'a substantially long draft in progress' }, 'draft is the last record');

  const reloaded = new FrecencyStore(file);
  assert.equal(reloaded.draft, 'a substantially long draft in progress', 'draft survives a reload (crash recovery)');

  reloaded.clearDraft();
  assert.equal(reloaded.draft, null);
  parsed = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(parsed.every((r) => r.type === 'history'), 'clean session end leaves no draft behind');

  const empty = new FrecencyStore(join(tmpStore().dir, 'nope', 'missing.jsonl'));
  empty.add('x', NOW);
  assert.ok(existsSync(empty.file), 'the store creates parent directories on write');
});
