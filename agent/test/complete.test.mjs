// Completion trigger strictness + candidate ranking (prefix doubling, frecency
// weighting, cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { triggerOf, rankCandidates } from '../src/tui/complete.js';
import { FrecencyStore } from '../src/tui/frecency.js';

const NOW = Date.parse('2025-01-15T12:00:00Z');

test('complete: triggers at line start or after whitespace only', () => {
  assert.deepEqual(triggerOf('/th'), { kind: 'slash', start: 0, query: 'th' });
  assert.deepEqual(triggerOf('run /th'), { kind: 'slash', start: 4, query: 'th' });
  assert.deepEqual(triggerOf('open @src'), { kind: 'mention', start: 5, query: 'src' });
  assert.deepEqual(triggerOf('@'), { kind: 'mention', start: 0, query: '' });
  assert.deepEqual(triggerOf('/'), { kind: 'slash', start: 0, query: '' });
});

test('complete: no trigger mid-word, after whitespace-free prefixes, or with spaces in the query', () => {
  assert.equal(triggerOf('a/th'), null, 'slash mid-word does not trigger');
  assert.equal(triggerOf('file.txt@x'), null, 'mention glued to a word does not trigger');
  assert.equal(triggerOf('/cle args'), null, 'arguments after the command word kill the trigger');
  assert.equal(triggerOf('/th x'), null, 'a space in the query kills the trigger');
  assert.equal(triggerOf('plain text'), null);
});

test('complete: ranking doubles prefix hits and drops non-matches', () => {
  const items = [
    { name: '/theme', desc: 'd1' },
    { name: '/thinking', desc: 'd2' },
    { name: '/status', desc: 'd3' },
    { name: '/thesaurus', desc: 'd4' },
  ];
  const ranked = rankCandidates('th', items, null, { now: NOW });
  // both prefix hits outrank everything; /status never matches
  assert.deepEqual(ranked.map((i) => i.name), ['/theme', '/thinking', '/thesaurus'].filter((n) => {
    return items.map((i) => i.name).includes(n);
  }));
  assert.ok(!ranked.some((i) => i.name === '/status'), 'non-matching candidate dropped');
});

test('complete: substring matches rank below prefix hits', () => {
  const items = [{ name: 'src/readme.md' }, { name: 'README.md' }];
  const ranked = rankCandidates('readme', items, null, { now: NOW });
  assert.equal(ranked[0].name, 'README.md', 'prefix hit wins');
  assert.equal(ranked[1].name, 'src/readme.md', 'substring hit still listed');
});

test('complete: frecency breaks ties toward frequently used entries', () => {
  const store = new FrecencyStore(null);
  store.add('/status', NOW); // count 1
  store.add('/theme', NOW);
  store.add('/theme', NOW); // count 2 -> wins the tie
  const items = [{ name: '/status' }, { name: '/theme' }];
  const ranked = rankCandidates('t', items, store, { now: NOW });
  // both prefix-match 't' at base 2; /theme has the frecency bonus
  assert.deepEqual(ranked.map((i) => i.name), ['/theme', '/status']);
});

test('complete: result is capped at the limit', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ name: `/cmd${i}` }));
  assert.equal(rankCandidates('', items, null, { limit: 10 }).length, 10);
  assert.equal(rankCandidates('', items, null, { limit: 10 })[0].name, '/cmd0', 'stable order under ties');
  assert.equal(rankCandidates('', items, null, { limit: 3 }).length, 3);
});

test('complete: empty query matches everything at base weight', () => {
  const items = [{ name: '/a' }, { name: '/b' }, { name: '/c' }];
  assert.equal(rankCandidates('', items, null).length, 3);
});
