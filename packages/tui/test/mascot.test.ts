import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mascotFrame, mascotState } from '../src/components/cowcat-art.js';
import { initialView } from '../src/app/view.js';

const STATES = ['idle', 'thinking', 'tools', 'approval', 'success', 'failed'] as const;
const ROLES = new Set(['backdrop', 'on', 'furDark', 'furMid', 'furLight', 'iris', 'eye', 'nose', 'highlight', null]);

test('the primary turn drives the cow cat, including an approval and tool activity', () => {
  assert.equal(mascotState({ ...initialView(), turn: { id: 't', state: 'streaming', reason: null, cronSourced: false } }, 1_000), 'thinking');
  assert.equal(mascotState({ ...initialView(), turn: { id: 't', state: 'awaiting_tools', reason: null, cronSourced: false } }, 1_000), 'tools');
  const approval = {
    callId: 'c', name: 'Bash', rule: 'ask', reason: null, warning: null, command: null, path: null,
    dimensions: [], askedAt: 0, verdict: null, by: null,
  };
  assert.equal(mascotState({ ...initialView(), approval }, 1_000), 'approval');
  assert.equal(mascotState({ ...initialView(), turn: { id: 't', state: 'completed', reason: null, cronSourced: false }, turnSettledAt: 1_000 }, 1_200), 'success');
  assert.equal(mascotState({ ...initialView(), turn: { id: 't', state: 'failed', reason: 'x', cronSourced: false }, turnSettledAt: 1_000 }, 5_000), 'idle');
});

test('every state is a 64 by 40 grayscale dot matrix with a sparse transparent backdrop', () => {
  for (const state of STATES) {
    const pixels = mascotFrame(state, 1_000);
    assert.equal(pixels.length, 40);
    assert.ok(pixels.every((row) => row.length === 64));
    assert.ok(pixels.flat().every((pixel) => ROLES.has(pixel)));
    assert.ok(pixels.flat().some((pixel) => pixel === null));
    assert.ok(pixels.flat().some((pixel) => 'backdrop' === pixel));
    assert.equal((pixels.flat() as string[]).includes('fur'), false);
    assert.equal((pixels.flat() as string[]).includes('patch'), false);
  }
});

test('idle breathing changes visible gray pixels without moving the silhouette', () => {
  assert.notDeepEqual(mascotFrame('idle', 0), mascotFrame('idle', 1_400));
});

test('thinking and tools animate without changing dimensions and reduced motion is static', () => {
  assert.notDeepEqual(mascotFrame('thinking', 0), mascotFrame('thinking', 600));
  assert.notDeepEqual(mascotFrame('tools', 0), mascotFrame('tools', 240));
  for (const state of STATES) assert.deepEqual(mascotFrame(state, 0, false), mascotFrame(state, 600, false));
});

test('tools squints, approval widens, success smiles and failure droops', () => {
  const eyeCount = (state: typeof STATES[number]): number => mascotFrame(state, 0).flat().filter((pixel) => pixel === 'eye').length;
  assert.ok(eyeCount('approval') > eyeCount('tools'));
  assert.notDeepEqual(mascotFrame('success', 0), mascotFrame('idle', 0));
  assert.notDeepEqual(mascotFrame('failed', 0), mascotFrame('idle', 0));
  assert.deepEqual(mascotFrame('failed', 0), mascotFrame('failed', 180));
});


test('both pupils look left, center and right together', () => {
  const eyeXs = (now: number): number[] => [...new Set(mascotFrame('thinking', now).flatMap((row) => row.flatMap((pixel, x) => pixel === 'eye' ? [x] : [])))].sort((a, b) => a - b);
  const left = eyeXs(0);
  const center = eyeXs(600);
  const right = eyeXs(1_200);
  assert.ok(left.every((x, index) => x < (center[index] ?? -1)));
  assert.ok(center.every((x, index) => x < (right[index] ?? -1)));
});
