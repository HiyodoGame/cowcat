import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paletteCommandAt, paletteMatches } from '../src/app/commands.js';
import { closePalette, initialView, movePalette, openPalette, withInput } from '../src/app/view.js';
import { commandPalette } from '../src/components/palette.js';

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
  assert.equal(closePalette(view).input, 'original draft');
});

test('palette rows are native choices with a background-selected hit target', () => {
  let view = openPalette(initialView());
  view = withInput(view, 'tasks');
  const panel = commandPalette(paletteMatches(view), 0, 48);
  assert.equal(panel.kind, 'panel');
  const choice = panel.kind === 'panel' ? panel.children[0] : undefined;
  assert.deepEqual(choice, { kind: 'choice', key: 'command-0', text: '/tasks  后台任务：查看与终止', selected: true, token: 'textDim', hit: 'palette:0' });
  assert.equal(paletteCommandAt(view, 0), paletteMatches(view)[0]);
  assert.equal(paletteCommandAt(view, 4), undefined);
});
