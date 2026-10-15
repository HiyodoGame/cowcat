// W3 Task 10: minimal input box (buildInputBox) + status-bar chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { buildInputBox, renderStatus, visibleLen } from '../src/tui/render.js';
import { getTheme } from '../src/tui/theme.js';
import { TuiUI } from '../src/tui/ui.js';

const theme = getTheme('dark', '256');
const PH_ZH = '输入消息，/ 命令，@ 文件';
const PH_EN = 'Type a message, / for commands, @ for files';
const RULE = (w) => '─'.repeat(w);

test('buildInputBox: empty input shows placeholder behind a > prompt between rule lines', () => {
  const lines = buildInputBox({ text: '', width: 40, theme, placeholder: PH_ZH });
  assert.equal(lines.length, 3, 'rule + body + rule');
  assert.equal(lines[0].replace(/\x1b\[[0-9;]*m/g, ''), RULE(40));
  assert.equal(lines[2].replace(/\x1b\[[0-9;]*m/g, ''), RULE(40));
  assert.ok(lines[0].includes(theme.permission), 'rule line uses theme.permission SGR');
  const body = lines[1].replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(body.startsWith('> '), 'brand-bold > prompt');
  assert.ok(body.includes(PH_ZH), 'placeholder visible when input is empty');
  assert.ok(lines[1].includes(theme.inactive), 'placeholder dimmed');
  for (const l of lines) assert.equal(visibleLen(l), 40, 'every box line is exactly width');

  const narrow = buildInputBox({ text: '', width: 20, theme, placeholder: PH_ZH });
  assert.equal(narrow[0].replace(/\x1b\[[0-9;]*m/g, ''), RULE(20));
  assert.ok(narrow.every((l) => visibleLen(l) === 20));

  const clamped = buildInputBox({ text: 'ab', width: 4, theme, placeholder: '' });
  assert.ok(clamped.every((l) => visibleLen(l) === 6), 'width < 6 clamps to the 6-column floor');
});

test('buildInputBox: no rounded corners, no side borders anywhere', () => {
  const lines = buildInputBox({ text: 'hello', width: 30, theme, placeholder: PH_EN });
  const all = lines.join('');
  for (const ch of ['╭', '╮', '╰', '╯', '│']) {
    assert.ok(!all.includes(ch), `no ${ch}`);
  }
  assert.ok(!lines.some((l) => l.includes(PH_EN)), 'placeholder gone once text is present');
  assert.ok(lines[1].replace(/\x1b\[[0-9;]*m/g, '').startsWith('> hello'), 'text after the > prompt');
});

test('buildInputBox: no theme renders plain rule lines, placeholder unstyled', () => {
  const lines = buildInputBox({ text: '', width: 12, theme: null, placeholder: PH_EN });
  assert.equal(lines[0], RULE(12));
  assert.equal(lines[2], RULE(12));
  assert.ok(!lines.join('').includes('\x1b['), 'no ANSI without theme');
});

test('buildInputBox: multiline keeps all lines, indents continuations by 2, plus a spare row', () => {
  const lines = buildInputBox({ text: 'a\nb', width: 16, theme, placeholder: '', multiline: true });
  const body = lines.slice(1, -1);
  assert.equal(body.length, 3, 'two text lines + one spare row');
  assert.ok(body[0].replace(/\x1b\[[0-9;]*m/g, '').startsWith('> a'), 'first row carries the prompt');
  assert.ok(body[1].replace(/\x1b\[[0-9;]*m/g, '').startsWith('  b'), 'continuation rows indent by 2');
  assert.equal(body[2].replace(/\x1b\[[0-9;]*m/g, ''), ' '.repeat(16), 'spare row is blank (padded to width)');
});

test('buildInputBox: cursor scrolls a long last line so the cursor stays visible', () => {
  const text = 'x'.repeat(40);
  const lines = buildInputBox({ text, width: 20, theme, placeholder: '', cursor: 40 });
  const last = lines[lines.length - 2];
  const plain = last.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('xxxxxxxxxx'), 'tail of the long line is shown');
  assert.ok(visibleLen(last) === 20);
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

test('TuiUI: rule-line input box, context-line hint, chip status bar', () => {
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
  assert.equal(plain.filter((l) => l === RULE(60)).length, 2, 'top and bottom rule lines');
  assert.ok(box.some((l) => l.replace(/\x1b\[[0-9;]*m/g, '').startsWith('> ') && l.includes(PH_ZH)), 'zh placeholder behind the prompt');
  const context = plain[0];
  assert.ok(context.startsWith('› '), 'context line above the input box');
  assert.ok(context.includes('shift+tab 切换模式'), 'hint lives in the context line now');
  const status = tui._status();
  assert.ok(status.includes('需要时询问'), 'permission chip');
  assert.ok(!status.includes('快捷键'), 'status bar no longer carries the hint');
  // a pending approval suppresses the hint in the context line
  tui._pendingApproval = { resolve: () => {}, card: null, entry: null };
  assert.ok(!tui._inputBox()[0].includes('shift+tab'), 'no hint while approval pending');
  tui.close();
});
