import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brailleCell } from '../src/ui/braille.js';
import type { SpriteColor } from '../src/ui/scene.js';

function cell(points: readonly (readonly (SpriteColor | null)[])[]) {
  return brailleCell(points, 0, 0);
}

test('braille maps each of the eight logical points to its standard dot', () => {
  const cases = [
    { point: [0, 0], glyph: '⠁' },
    { point: [0, 1], glyph: '⠂' },
    { point: [0, 2], glyph: '⠄' },
    { point: [1, 0], glyph: '⠈' },
    { point: [1, 1], glyph: '⠐' },
    { point: [1, 2], glyph: '⠠' },
    { point: [0, 3], glyph: '⡀' },
    { point: [1, 3], glyph: '⢀' },
  ] as const;
  for (const item of cases) {
    const pixels = Array.from({ length: 4 }, (_, y) => Array.from({ length: 2 }, (_, x) => x === item.point[0] && y === item.point[1] ? 'on' : null));
    assert.deepEqual(cell(pixels), { glyph: item.glyph, foreground: 'on', background: null });
  }
  assert.deepEqual(cell(Array.from({ length: 4 }, () => ['on', 'on'])), { glyph: '⣿', foreground: 'on', background: null });
});

test('transparent cells stay blank and important details win without a background fill', () => {
  assert.deepEqual(cell(Array.from({ length: 4 }, () => [null, null])), { glyph: ' ', foreground: null, background: null });
  const pixels: (SpriteColor | null)[][] = Array.from({ length: 4 }, () => ['nose', 'nose']);
  pixels[0] = ['eye', 'nose'];
  assert.deepEqual(cell(pixels), { glyph: '⠁', foreground: 'eye', background: null });
  assert.equal(cell(Array.from({ length: 4 }, () => ['backdrop', 'backdrop'])).foreground, 'backdrop');
});

test('each terminal cell advances two columns and four rows', () => {
  const pixels: (SpriteColor | null)[][] = Array.from({ length: 8 }, () => Array.from({ length: 4 }, () => null));
  const row = pixels[4];
  assert.ok(row);
  row[2] = 'nose';
  assert.deepEqual(brailleCell(pixels, 1, 1), { glyph: '⠁', foreground: 'nose', background: null });
});
