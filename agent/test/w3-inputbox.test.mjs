// W3 Task 10: composer box (left-border-only, Open Code style) + status bar.
// Visual contract updated for the OC 2.0 chrome redo (phase: composer redo):
// the box is a single left border bar with a raised background — no top/bottom
// rules, no right edge, no spare editing row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { buildInputBox, renderStatus, visibleLen } from '../src/tui/render.js';
import { getTheme } from '../src/tui/theme.js';
import { TuiUI } from '../src/tui/ui.js';

const theme = getTheme('dark', '256');
const PH_ZH = '输入消息，/ 命令，@ 文件';
const PH_EN = 'Type a message, / for commands, @ for files';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// the box is ONE row per draft line: `▎ <pad>› <content>` on a raised bg
const barOf = (line) => line.slice(0, line.indexOf('▎') + 1);

test('buildInputBox: left border bar only — placeholder behind the › prompt', () => {
  const lines = buildInputBox({ text: '', width: 40, theme, placeholder: PH_ZH });
  assert.equal(lines.length, 1, 'one row for the empty draft (no rules, no spare row)');
  const plain = strip(lines[0]);
  assert.ok(plain.startsWith('▎'), 'left border bar first');
  assert.ok(plain.includes('› '), 'brand-bold › prompt');
  assert.ok(plain.includes(PH_ZH), 'placeholder visible when input is empty');
  assert.ok(lines[0].includes(theme.brand), 'bar + prompt use the brand token');
  assert.ok(lines[0].includes(theme.inactive), 'placeholder dimmed');
  assert.ok(lines[0].includes(theme.userBubbleBg), 'raised background');
  assert.ok(!plain.slice(1).includes('│'), 'no other border characters');
  assert.equal(visibleLen(lines[0]), 40, 'the row spans the full width');
  assert.ok(plain.endsWith(' '), 'trailing area blank-padded');

  const narrow = buildInputBox({ text: '', width: 20, theme, placeholder: PH_ZH });
  assert.equal(visibleLen(narrow[0]), 20);
  assert.ok(strip(narrow[0]).indexOf('›') <= 3, 'narrow mode uses the 1-col padding');

  const clamped = buildInputBox({ text: 'ab', width: 4, theme, placeholder: '' });
  assert.ok(clamped.every((l) => visibleLen(l) === 6), 'width < 6 clamps to the 6-column floor');
});

test('buildInputBox: text row, no placeholder leak, no right edge', () => {
  const lines = buildInputBox({ text: 'hello', width: 30, theme, placeholder: PH_EN });
  assert.equal(lines.length, 1);
  const plain = strip(lines[0]);
  assert.ok(plain.startsWith('▎'), 'left border');
  assert.ok(plain.includes('› hello'), 'text after the › prompt');
  assert.ok(!plain.includes(PH_EN), 'placeholder gone once text is present');
  assert.ok(!plain.slice(1).includes('▎'), 'exactly one bar');
});

test('buildInputBox: no theme renders a plain bar and unstyled placeholder', () => {
  const lines = buildInputBox({ text: '', width: 12, theme: null, placeholder: PH_EN });
  assert.equal(lines.length, 1);
  assert.ok(!lines.join('').includes('\x1b['), 'no ANSI without theme');
  assert.ok(strip(lines[0]).startsWith('▎'), 'the bar char survives without a theme');
});

test('buildInputBox: multiline keeps all lines, continuations indent under the text', () => {
  const lines = buildInputBox({ text: 'a\nb', width: 16, theme, placeholder: '', multiline: true });
  assert.equal(lines.length, 2, 'one row per line — no spare editing row');
  assert.ok(strip(lines[0]).includes('› a'), 'first row carries the prompt');
  assert.ok(strip(lines[1]).includes('  b'), 'continuation rows indent by 2 under the text');
});

test('buildInputBox: cursor (display column) scrolls a long last line into view', () => {
  const text = 'x'.repeat(40);
  const lines = buildInputBox({ text, width: 20, theme, placeholder: '', cursor: 40 });
  const last = lines[lines.length - 1];
  const plain = strip(last);
  assert.ok(plain.includes('xxxxxxxxxx'), 'tail of the long line is shown');
  assert.equal(visibleLen(last), 20);
});

test('renderStatus: chips for permission/mode/model with separators, cwd right-aligned', () => {
  const s = renderStatus({ cost: '$0', permMode: 'default', mode: 'default', model: 'kimi', cwd: '/repo', lang: 'en' }, 100, theme);
  assert.equal(visibleLen(s), 100);
  assert.ok(s.includes('$0'), 'cost chip');
  assert.ok(s.includes('Ask When Needed'), 'permission chip');
  assert.ok(s.includes(theme.warning), 'permission chip uses theme.warning');
  assert.ok(s.includes(theme.success), 'mode chip uses theme.success');
  assert.ok(s.includes('kimi'), 'model chip');
  assert.ok(s.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().endsWith('/repo'), 'cwd right-aligned');
  const noCost = renderStatus({ permMode: 'yolo', mode: 'default', model: 'm', cwd: '/r', lang: 'zh' }, 80, theme);
  assert.ok(!noCost.replace(/\x1b\[[0-9;]*m/g, '').includes('$'), 'cost omitted when empty');
  assert.ok(noCost.includes('全部自动允许'), 'zh permission label');
});

test('TuiUI: left-border composer, metadata row, deduped status bar', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 60;
  output.rows = 24;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'zh', version: '0.11.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  const box = tui._inputBox();
  const plain = box.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // OC layout: metadata row (`model · mode`) above the left-border composer
  assert.equal(plain.length, 2, 'metadata row + one composer row');
  assert.ok(plain[0].includes('m'), 'metadata row carries the model');
  assert.ok(plain[0].includes('act'), 'metadata row carries the mode');
  assert.ok(plain[1].startsWith('▎'), 'composer row starts with the left border bar');
  assert.ok(plain[1].includes('› '), '› prompt');
  assert.ok(box[1].includes(PH_ZH), 'zh placeholder behind the prompt');
  const status = strip(tui._status());
  assert.ok(status.includes('/x'), 'status bar carries the cwd cluster');
  assert.ok(!status.includes('/x:'), 'no branch placeholder while git is unresolved');
  assert.ok(!status.includes('m ·'), 'the model appears only in the metadata row');
  // a pending approval replaces the composer with the PermissionPrompt
  tui._pendingApproval = { resolve: () => {}, card: null, entry: null };
  assert.ok(!tui._inputBox()[0].includes('shift+tab'), 'no hint while approval pending');
  tui.close();
});
