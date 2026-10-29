import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mascotFrame } from '../src/components/cowcat-art.js';
import { heightOf, spriteBlock } from '../src/ui/scene.js';

test('the static cat is symmetric, has one small nose and no protruding right ear', () => {
  for (const state of ['idle', 'success'] as const) {
    const pixels = mascotFrame(state, 0, false);
    for (const row of pixels) for (let x = 0; x < 41; x += 1) assert.equal(row[x], row[81 - x]);
  }
  const pixels = mascotFrame('idle', 0, false);
  const nose = pixels.flatMap((row, y) => row.flatMap((pixel, x) => pixel === 'nose' ? [{ x, y }] : []));
  assert.deepEqual(nose, [{ x: 40, y: 34 }, { x: 41, y: 34 }, { x: 40, y: 35 }, { x: 41, y: 35 }]);
  const shape = pixels.flatMap((row) => row.flatMap((pixel, x) => (pixel as string) === 'backdrop' || pixel === null ? [] : [x]));
  assert.equal(Math.min(...shape), 10);
  assert.equal(Math.max(...shape), 71);
});

test('the quadrant avatar occupies 23 terminal rows', () => {
  const sprite = spriteBlock('cat', mascotFrame('idle', 0));
  assert.equal(heightOf(sprite), 23);
});

test('success has one pulse and reduced motion stays still', () => {
  assert.notDeepEqual(mascotFrame('success', 0), mascotFrame('success', 400));
  assert.deepEqual(mascotFrame('success', 0, false), mascotFrame('success', 400, false));
});
