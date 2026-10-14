// W1 Task 5: unified theme tokens wired into both UIs (line-mode palette +
// TuiUI re-theme with entry-cache invalidation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { getTheme } from '../src/tui/theme.js';
import { ansiStateCarry } from '../src/tui/render.js';
import { UI, COPY, ANSI } from '../src/ui.js';
import { TuiUI } from '../src/tui/ui.js';

const DARK = getTheme('dark', '256');
const LIGHT = getTheme('light', '256');

test('theme-apply: line-mode setTheme re-parses the palette in place, COPY untouched', () => {
  const ui = new UI({ colors: false });
  const paletteRef = ANSI;
  const copyBefore = structuredClone(COPY);
  assert.equal(ANSI.success, DARK.success);
  assert.ok(ui.setTheme('light'));
  assert.equal(ANSI, paletteRef, 'palette object identity stays stable');
  assert.equal(ANSI.success, LIGHT.success, 'a token value follows the light theme');
  assert.notEqual(ANSI.success, DARK.success);
  assert.deepEqual(COPY, copyBefore, 'line-mode COPY文案不变');
  assert.equal(ui.themeName, 'light');
  assert.ok(ui.setTheme('dark'));
  assert.equal(ANSI.success, DARK.success, 'switching back restores dark tokens');
  assert.equal(ui.setTheme('nope'), false, 'unknown theme rejected');
});

function headlessTui(config = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const frames = [];
  const tui = new TuiUI({
    input, output, colors: true, version: '0.8.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000, ...config }),
    getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = (lines) => { frames.push(lines); };
  tui.screen.active = true;
  return { tui, frames };
}

test('theme-apply: TuiUI constructor picks up getConfig().theme', () => {
  const { tui } = headlessTui({ theme: 'light' });
  assert.equal(tui.themeName, 'light');
  assert.equal(tui.theme.success, LIGHT.success);
  tui.close();
  const { tui: d } = headlessTui();
  assert.equal(d.themeName, 'dark', 'no theme in config defaults to dark');
  d.close();
});

test('theme-apply: TuiUI setTheme re-themes header/status/card border and dirties every entry', () => {
  const { tui, frames } = headlessTui();
  tui.print('hello');
  tui.toolCall('Bash', 'node -v');
  tui.toolSuccess();
  assert.ok(tui.entries.length >= 2);
  assert.ok(tui.entries.every((e) => e._rendered !== null), 'entries cached after draw');
  tui._draw();
  const darkFrame = frames.at(-1).join('\n');
  assert.ok(darkFrame.includes(DARK.success), 'dark header meter color');
  assert.ok(darkFrame.includes(DARK.inactive), 'dark status/card-border gray');
  tui.screen.active = false; // observe the dirty marking without the immediate redraw
  assert.ok(tui.setTheme('light'));
  assert.ok(tui.entries.every((e) => e._rendered === null), 'all entries marked dirty for one-shot redraw');
  tui.screen.active = true;
  tui._draw();
  const lightFrame = frames.at(-1).join('\n');
  assert.ok(lightFrame.includes(LIGHT.success), 'light header meter color after switch');
  assert.ok(lightFrame.includes(LIGHT.inactive), 'light card border color after switch');
  assert.ok(!lightFrame.includes(DARK.success), 'no stale dark header color');
  assert.equal(tui.setTheme('nope'), false);
  tui.close();
});

test('render: ansiStateCarry clears extended colors as a unit (38;5;N / 48;2;r;g;b)', () => {
  assert.equal(ansiStateCarry('\x1b[38;5;204mabc\x1b[39m'), '', '39 clears the whole 38;5;N unit');
  assert.equal(ansiStateCarry('\x1b[38;5;204mabc'), '\x1b[38;5;204m');
  assert.equal(ansiStateCarry('\x1b[48;2;1;2;3mabc\x1b[49m'), '', '49 clears the whole 48;2;r;g;b unit');
  assert.equal(ansiStateCarry('\x1b[1m\x1b[38;5;204mabc'), '\x1b[1;38;5;204m', 'plain attrs and units compose');
});
