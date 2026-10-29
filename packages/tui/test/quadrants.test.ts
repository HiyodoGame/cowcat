import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quadrantCell } from '../src/ui/quadrants.js';
import type { SpriteColor } from '../src/ui/scene.js';

const cell = (topLeft: SpriteColor | null, topRight: SpriteColor | null, bottomLeft: SpriteColor | null, bottomRight: SpriteColor | null) => quadrantCell([
  [topLeft, topRight], [bottomLeft, bottomRight],
], 0, 0);

test('quadrants cover empty, halves, diagonals and full cells', () => {
  assert.deepEqual(cell(null, null, null, null), { glyph: ' ', foreground: null, background: null });
  assert.deepEqual(cell('on', 'on', null, null), { glyph: '▀', foreground: 'on', background: null });
  assert.deepEqual(cell(null, null, 'on', 'on'), { glyph: '▄', foreground: 'on', background: null });
  assert.deepEqual(cell('on', null, 'on', null), { glyph: '▌', foreground: 'on', background: null });
  assert.deepEqual(cell(null, 'on', null, 'on'), { glyph: '▐', foreground: 'on', background: null });
  assert.deepEqual(cell('on', null, null, 'on'), { glyph: '▚', foreground: 'on', background: null });
  assert.deepEqual(cell('on', 'on', 'on', 'on'), { glyph: '█', foreground: 'on', background: null });
});

test('the backdrop is a small dot and never becomes a solid block wall', () => {
  assert.deepEqual(cell('backdrop', 'backdrop', 'backdrop', 'backdrop'), { glyph: '▪', foreground: 'backdrop', background: null });
  assert.deepEqual(cell('backdrop', null, 'backdrop', null), { glyph: '▪', foreground: 'backdrop', background: null });
});

test('transparency and multiple colors degrade deterministically without losing important detail', () => {
  const transparent = cell('on', 'furDark', null, 'furMid');
  assert.equal(transparent.background, null);
  assert.notEqual(transparent.glyph, '█');

  const detailed = cell('eye', 'nose', 'on', 'furMid');
  assert.equal(detailed.foreground, 'eye');
  assert.equal(detailed.background, 'nose');

  const backdrop = cell('backdrop', 'on', 'backdrop', 'backdrop');
  assert.equal(backdrop.foreground, 'on');
  assert.equal(backdrop.background, null);
});


test('each terminal cell advances two logical columns', () => {
  const pixels = [['on', 'on', null, null], [null, null, 'nose', 'nose']] as const;
  assert.deepEqual(quadrantCell(pixels, 1, 0), { glyph: '▄', foreground: 'nose', background: null });
});
