// W3 Task 10: rounded input box (buildInputBox) + status-bar hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { buildInputBox, renderStatus, visibleLen } from '../src/tui/render.js';
import { getTheme } from '../src/tui/theme.js';
import { TuiUI } from '../src/tui/ui.js';

const theme = getTheme('dark', '256');
const PH_ZH = '输入消息，/ 命令，@ 文件';
const PH_EN = 'Type a message, / for commands, @ for files';

test('buildInputBox: empty input shows placeholder inside a rounded permission-tinted box', () => {
  const lines = buildInputBox({ text: '', width: 40, theme, placeholder: PH_ZH });
  assert.ok(lines.length >= 3, 'top border + content + bottom border');
  assert.ok(lines[0].includes('╭') && lines[0].includes('╮'));
  assert.ok(lines[lines.length - 1].includes('╰') && lines[lines.length - 1].includes('╯'));
  assert.ok(lines.some((l) => l.includes(PH_ZH)), 'placeholder visible when input is empty');
  assert.ok(lines[0].includes(theme.permission), 'border uses theme.permission SGR');
  for (const l of lines) assert.equal(visibleLen(l), 40, 'every box line is exactly width');

  const narrow = buildInputBox({ text: '', width: 20, theme, placeholder: PH_ZH });
  assert.ok(narrow[0].includes('╭') && narrow[0].includes(theme.permission));
  assert.ok(narrow[narrow.length - 1].includes('╰'));
  assert.ok(narrow.every((l) => visibleLen(l) === 20));

  const clamped = buildInputBox({ text: 'ab', width: 4, theme, placeholder: '' });
  assert.ok(clamped.every((l) => visibleLen(l) === 6), 'width < 6 clamps to the 6-column floor');
});

test('buildInputBox: placeholder disappears once text is present', () => {
  const lines = buildInputBox({ text: 'hello', width: 20, theme, placeholder: PH_EN });
  assert.ok(!lines.some((l) => l.includes('Type a message')), 'placeholder gone');
  assert.ok(lines.some((l) => l.includes('hello')));
});

test('buildInputBox: no theme renders plain borders, placeholder unstyled', () => {
  const lines = buildInputBox({ text: '', width: 12, theme: null, placeholder: PH_EN });
  assert.equal(lines[0], '╭──────────╮');
  assert.equal(lines[lines.length - 1], '╰──────────╯');
  assert.ok(!lines.join('').includes('\x1b['), 'no ANSI without theme');
});

test('buildInputBox: multiline keeps all lines and leaves a spare editing row', () => {
  const lines = buildInputBox({ text: 'a\nb', width: 16, theme, placeholder: '', multiline: true });
  const body = lines.slice(1, -1);
  assert.ok(body.some((l) => l.includes('a')) && body.some((l) => l.includes('b')));
  assert.equal(body.length, 3, 'two text lines + one spare row');
  assert.equal(body[2].replace(/\x1b\[[0-9;]*m/g, ''), '│' + ' '.repeat(14) + '│', 'spare row is blank');
});

test('buildInputBox: cursor scrolls a long last line so the cursor stays visible', () => {
  const text = 'x'.repeat(40);
  const lines = buildInputBox({ text, width: 20, theme, placeholder: '', cursor: 40 });
  const last = lines[lines.length - 2];
  const plain = last.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('xxxxxxxxxx'), 'tail of the long line is shown');
  assert.ok(visibleLen(last) === 20);
});

test('renderStatus: dim hint slot when no pending approval', () => {
  const hint = '? for shortcuts · shift+tab to switch mode';
  const s = renderStatus({ cost: '$0', version: '0.8.0', cwd: '/repo', mode: 'default', hint }, 100, theme);
  assert.equal(visibleLen(s), 100);
  assert.ok(s.includes('? for shortcuts'), 'hint text present');
  assert.ok(s.includes('shift+tab to switch mode'));
  assert.ok(s.includes(theme.inactive), 'hint rendered with theme.inactive SGR');
});

test('TuiUI: input box uses rounded permission border and status shows hints', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 60;
  output.rows = 24;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'zh', version: '0.8.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  const box = tui._inputBox();
  const top = box.find((l) => l.includes('╭'));
  assert.ok(top, 'rounded top border');
  assert.ok(box.some((l) => l.includes(PH_ZH)), 'zh placeholder on empty input');
  assert.ok(top.includes(tui.theme.permission), 'permission-tinted border');
  assert.ok(box.every((l) => !l.trim() || visibleLen(l) === 60), 'margin rows blank, box rows exact width');
  const status = tui._status();
  assert.ok(status.includes('? for shortcuts') || status.includes('? 快捷键'), 'status hint without pending approval');
  // a pending approval suppresses the hint
  tui._pendingApproval = { resolve: () => {}, card: null, entry: null };
  assert.ok(!tui._status().includes('shortcuts') && !tui._status().includes('快捷键'), 'no hint while approval pending');
  tui.close();
});
