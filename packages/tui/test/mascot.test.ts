import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mascotFrame, mascotState } from '../src/components/cowcat-art.js';
import { initialView } from '../src/app/view.js';

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

test('every frame is a fixed-size cow-spotted sprite, not a different ASCII layout', () => {
  for (const state of ['idle', 'thinking', 'tools', 'approval', 'success', 'failed'] as const) {
    const pixels = mascotFrame(state, 1_000);
    assert.ok(pixels.length >= 12);
    assert.ok(pixels.every((row) => row.length === 24));
    const colors = new Set(pixels.flat());
    assert.ok(colors.has('fur'));
    assert.ok(colors.has('patch'));
    assert.ok(colors.has('nose'));
  }
});

test('thinking and tool animations move without changing dimensions; disabled motion is static', () => {
  assert.notDeepEqual(mascotFrame('thinking', 0), mascotFrame('thinking', 240));
  assert.notDeepEqual(mascotFrame('tools', 0), mascotFrame('tools', 200));
  assert.deepEqual(mascotFrame('tools', 0, false), mascotFrame('tools', 1_000, false));
  assert.notDeepEqual(mascotFrame('idle', 0), mascotFrame('idle', 4_000));
});
