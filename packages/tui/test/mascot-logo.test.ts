import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mascotFrame } from '../src/components/cowcat-art.js';
import { heightOf, spriteBlock } from '../src/ui/scene.js';

test('the static cat is symmetric, has one small nose and no protruding right ear', () => {
  for (const state of ['idle', 'success'] as const) {
    const pixels = mascotFrame(state, 0, false);
    for (const row of pixels) for (let x = 0; x < 32; x += 1) assert.equal(row[x], row[63 - x]);
  }
  const pixels = mascotFrame('idle', 0, false);
  const nose = pixels.flatMap((row, y) => row.flatMap((pixel, x) => pixel === 'nose' ? [{ x, y }] : []));
  assert.deepEqual(nose, [{ x: 31, y: 30 }, { x: 32, y: 30 }]);
  const shape = pixels.flatMap((row) => row.flatMap((pixel, x) => (pixel as string) === 'backdrop' || pixel === null ? [] : [x]));
  assert.equal(Math.min(...shape), 8);
  assert.equal(Math.max(...shape), 55);
});

test('the Braille avatar occupies ten terminal rows', () => {
  const sprite = spriteBlock('cat', mascotFrame('idle', 0));
  assert.equal(heightOf(sprite), 10);
});

test('success has one pulse and reduced motion stays still', () => {
  assert.notDeepEqual(mascotFrame('success', 0), mascotFrame('success', 400));
  assert.deepEqual(mascotFrame('success', 0, false), mascotFrame('success', 400, false));
});


test('success pulses once from the actual settlement time and never repeats', () => {
  const bright = mascotFrame('success', 400, true, 1_000);
  const settled = mascotFrame('success', 1_400, true, 1_000);
  assert.notDeepEqual(bright, settled);
  assert.deepEqual(settled, mascotFrame('success', 1_800, true, 1_000));
  assert.deepEqual(settled, mascotFrame('success', 2_200, true, 1_000));
});
