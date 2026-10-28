import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mascotFrame } from '../src/components/cowcat-art.js';
import { heightOf, spriteBlock } from '../src/ui/scene.js';

test('the milk-rogue logo tilts with one upright ear and one outward ear', () => {
  const pixels = mascotFrame('idle', 0);
  assert.equal(pixels.length, 20);
  assert.ok(pixels.every((row) => row.length === 28));
  assert.equal(pixels[0]?.[9], 'patch', 'one dark ear stays upright');
  assert.equal(pixels[5]?.[27], 'patch', 'the other ear points outward');
  assert.equal(pixels[10]?.[11], 'fur', 'left eye has a bright glint');
  assert.equal(pixels[10]?.[20], 'fur', 'right eye has a bright glint');
  assert.equal(pixels[14]?.[8], 'nose', 'one cheek is pink');
});

test('half-pixel avatar rows occupy half the logical pixel height', () => {
  const sprite = spriteBlock('cat', mascotFrame('idle', 0));
  assert.equal(heightOf(sprite), 10);
});

test('success has a small hop and settles while reduced motion stays still', () => {
  assert.notDeepEqual(mascotFrame('success', 0), mascotFrame('success', 400));
  assert.deepEqual(mascotFrame('success', 0, false), mascotFrame('success', 400, false));
  assert.notDeepEqual(mascotFrame('thinking', 0), mascotFrame('thinking', 600));
});

test('reduced motion freezes every mascot state', () => {
  for (const state of ['idle', 'thinking', 'tools', 'approval', 'success', 'failed'] as const) {
    assert.deepEqual(mascotFrame(state, 0, false), mascotFrame(state, 600, false));
  }
});
