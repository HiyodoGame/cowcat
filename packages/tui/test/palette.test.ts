import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paletteCommandAt, paletteMatches } from '../src/app/commands.js';
import { closePalette, initialView, movePalette, openPalette, withInput } from '../src/app/view.js';
import { paletteLines } from '../src/components/palette.js';

test('palette filtering is case-insensitive across names and summaries', () => {
  let view = openPalette(initialView());
  view = withInput(view, 'TASK');
  assert.deepEqual(paletteMatches(view).map((command) => command.name), ['tasks']);
  view = withInput(view, '定时任务');
  assert.deepEqual(paletteMatches(view).map((command) => command.name), ['cron']);
  view = withInput(view, 'no-such-command');
  assert.deepEqual(paletteMatches(view), []);
});

test('palette queries reset selection and closing restores the original draft', () => {
  let view = openPalette({ ...initialView(), input: 'original draft' });
  assert.equal(view.input, '');
  view = movePalette(view, 1, 4);
  assert.equal(view.palette?.index, 1);
  view = withInput(view, 'tasks');
  assert.equal(view.palette?.index, 0);
  const restored = closePalette(view);
  assert.equal(restored.input, 'original draft');
  assert.equal(restored.palette, null);
});

test('palette rows are clickable and resolve through the same command lookup', () => {
  let view = openPalette(initialView());
  view = withInput(view, 'tasks');
  const lines = paletteLines(paletteMatches(view), 0, 48);
  assert.equal(lines[1]?.hit, 'palette:0');
  assert.equal(paletteCommandAt(view, 0), paletteMatches(view)[0]);
  assert.equal(paletteCommandAt(view, 4), undefined);
});
