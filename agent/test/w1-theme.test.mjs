// W1 Task 3: semantic color token system (pure, no env).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOKENS, getTheme } from '../src/tui/theme.js';

const EXPECTED_TOKENS = [
  'brand', 'permission', 'promptBorder', 'text', 'inactive', 'subtle',
  'success', 'error', 'warning', 'cyan', 'bashBorder', 'userBubbleBg', 'bashBubbleBg',
  'planMode', 'autoAccept', 'diffAddedFg', 'diffAddedBg',
  'diffRemovedFg', 'diffRemovedBg',
];

test('theme: TOKENS lists exactly the 18 semantic tokens', () => {
  assert.deepEqual(TOKENS, EXPECTED_TOKENS);
});

test('theme: dark/256 locks hand-picked nearest xterm-256 values', () => {
  const t = getTheme('dark', '256');
  assert.equal(t.brand, '\x1b[38;5;209m');
  assert.equal(t.permission, '\x1b[38;5;147m');
  assert.equal(t.promptBorder, '\x1b[38;5;102m');
  assert.equal(t.text, '\x1b[38;5;231m');
  assert.equal(t.inactive, '\x1b[38;5;246m');
  assert.equal(t.subtle, '\x1b[38;5;239m');
  assert.equal(t.success, '\x1b[38;5;78m');
  assert.equal(t.error, '\x1b[38;5;204m');
  assert.equal(t.warning, '\x1b[38;5;220m');
  assert.equal(t.cyan, '\x1b[38;5;74m');
  assert.equal(t.bashBorder, '\x1b[38;5;205m');
  assert.equal(t.planMode, '\x1b[38;5;73m');
  assert.equal(t.autoAccept, '\x1b[38;5;141m');
  assert.equal(t.diffAddedFg, '\x1b[38;5;78m');
  assert.equal(t.diffAddedBg, '\x1b[48;5;22m');
  assert.equal(t.diffRemovedFg, '\x1b[38;5;204m');
  assert.equal(t.diffRemovedBg, '\x1b[48;5;52m');
});

test('theme: dark/24bit emits exact spec RGB', () => {
  const t = getTheme('dark', '24bit');
  assert.equal(t.brand, '\x1b[38;2;215;119;87m');
  assert.equal(t.permission, '\x1b[38;2;177;185;249m');
  assert.equal(t.promptBorder, '\x1b[38;2;136;136;136m');
  assert.equal(t.text, '\x1b[38;2;255;255;255m');
  assert.equal(t.inactive, '\x1b[38;2;153;153;153m');
  assert.equal(t.subtle, '\x1b[38;2;80;80;80m');
  assert.equal(t.success, '\x1b[38;2;78;186;101m');
  assert.equal(t.error, '\x1b[38;2;255;107;128m');
  assert.equal(t.warning, '\x1b[38;2;255;193;7m');
  assert.equal(t.cyan, '\x1b[38;2;95;175;215m');
  assert.equal(t.bashBorder, '\x1b[38;2;253;93;177m');
  assert.equal(t.userBubbleBg, '\x1b[48;2;55;55;55m');
  assert.equal(t.bashBubbleBg, '\x1b[48;2;65;60;65m');
  assert.equal(t.planMode, '\x1b[38;2;72;150;140m');
  assert.equal(t.autoAccept, '\x1b[38;2;175;135;255m');
  assert.equal(t.diffAddedFg, '\x1b[38;2;78;186;101m');
  assert.equal(t.diffAddedBg, '\x1b[48;2;24;70;35m');
  assert.equal(t.diffRemovedFg, '\x1b[38;2;255;107;128m');
  assert.equal(t.diffRemovedBg, '\x1b[48;2;70;30;35m');
});

test('theme: background tokens use background SGR in every level', () => {
  const BG16 = /^\x1b\[(4[0-7]|10[0-7])m$/;
  for (const level of ['16', '256', '24bit']) {
    const t = getTheme('dark', level);
    for (const token of ['userBubbleBg', 'bashBubbleBg', 'diffAddedBg', 'diffRemovedBg']) {
      const isBg = level === '16' ? BG16.test(t[token]) : t[token].startsWith('\x1b[48;');
      assert.ok(isBg, `${level} ${token} must be a background SGR: ${JSON.stringify(t[token])}`);
    }
    for (const token of TOKENS.filter((k) => !k.endsWith('Bg'))) {
      assert.ok(!isBgSgr(t[token], level), `${level} ${token} must be foreground`);
    }
  }
});

function isBgSgr(s, level) {
  if (level === '16') return /^\x1b\[(4[0-7]|10[0-7])m$/.test(s);
  return s.startsWith('\x1b[48;');
}

test('theme: dark/256 background tokens lock nearest xterm-256 greys/tints', () => {
  const t = getTheme('dark', '256');
  assert.equal(t.userBubbleBg, '\x1b[48;5;237m');
  assert.equal(t.bashBubbleBg, '\x1b[48;5;238m');
});

test('theme: light values come from the spec light column and differ from dark', () => {
  const dark = getTheme('dark', '24bit');
  const light = getTheme('light', '24bit');
  assert.equal(light.brand, '\x1b[38;2;215;119;87m');
  assert.equal(light.permission, '\x1b[38;2;87;105;247m');
  assert.equal(light.promptBorder, '\x1b[38;2;153;153;153m');
  assert.equal(light.text, '\x1b[38;2;0;0;0m');
  assert.equal(light.inactive, '\x1b[38;2;102;102;102m');
  assert.equal(light.subtle, '\x1b[38;2;175;175;175m');
  assert.equal(light.success, '\x1b[38;2;44;122;57m');
  assert.equal(light.error, '\x1b[38;2;171;43;63m');
  assert.equal(light.warning, '\x1b[38;2;150;108;30m');
  assert.equal(light.cyan, '\x1b[38;2;0;128;128m');
  assert.equal(light.bashBorder, '\x1b[38;2;255;0;135m');
  assert.equal(light.userBubbleBg, '\x1b[48;2;240;240;240m');
  assert.equal(light.bashBubbleBg, '\x1b[48;2;250;245;250m');
  assert.equal(light.planMode, '\x1b[38;2;0;102;102m');
  assert.equal(light.autoAccept, '\x1b[38;2;135;0;255m');
  assert.equal(light.diffAddedFg, '\x1b[38;2;47;157;68m');
  assert.equal(light.diffAddedBg, '\x1b[48;2;199;225;203m');
  assert.equal(light.diffRemovedFg, '\x1b[38;2;209;69;75m');
  assert.equal(light.diffRemovedBg, '\x1b[48;2;253;210;216m');
  assert.notEqual(light.text, dark.text);
  assert.notEqual(light.userBubbleBg, dark.userBubbleBg);
});

test('theme: light/256 locks nearest xterm-256 values', () => {
  const t = getTheme('light', '256');
  assert.equal(t.brand, '\x1b[38;5;209m');
  assert.equal(t.permission, '\x1b[38;5;63m');
  assert.equal(t.promptBorder, '\x1b[38;5;246m');
  assert.equal(t.text, '\x1b[38;5;16m');
  assert.equal(t.inactive, '\x1b[38;5;241m');
  assert.equal(t.subtle, '\x1b[38;5;145m');
  assert.equal(t.success, '\x1b[38;5;29m');
  assert.equal(t.error, '\x1b[38;5;125m');
  assert.equal(t.warning, '\x1b[38;5;94m');
  assert.equal(t.cyan, '\x1b[38;5;30m');
  assert.equal(t.bashBorder, '\x1b[38;5;198m');
  assert.equal(t.userBubbleBg, '\x1b[48;5;255m');
  assert.equal(t.bashBubbleBg, '\x1b[48;5;231m');
  assert.equal(t.planMode, '\x1b[38;5;23m');
  assert.equal(t.autoAccept, '\x1b[38;5;93m');
  assert.equal(t.diffAddedFg, '\x1b[38;5;29m');
  assert.equal(t.diffAddedBg, '\x1b[48;5;194m');
  assert.equal(t.diffRemovedFg, '\x1b[38;5;167m');
  assert.equal(t.diffRemovedBg, '\x1b[48;5;224m');
});

test('theme: 16-color level emits classic ANSI SGR codes', () => {
  const dark = getTheme('dark', '16');
  assert.equal(dark.brand, '\x1b[91m');
  assert.equal(dark.permission, '\x1b[94m');
  assert.equal(dark.text, '\x1b[97m');
  assert.equal(dark.success, '\x1b[92m');
  assert.equal(dark.error, '\x1b[91m');
  assert.equal(dark.cyan, '\x1b[36m');
  assert.equal(dark.userBubbleBg, '\x1b[100m');
  assert.equal(dark.diffAddedBg, '\x1b[42m');
  const light = getTheme('light', '16');
  assert.equal(light.text, '\x1b[30m');
  assert.equal(light.permission, '\x1b[34m');
  assert.equal(light.cyan, '\x1b[36m');
  assert.equal(light.userBubbleBg, '\x1b[47m');
});

test('theme: level defaults to 256 and unknown values are rejected', () => {
  const t = getTheme('dark');
  assert.equal(t.brand, '\x1b[38;5;209m');
  assert.throws(() => getTheme('dark', '999'), /level/);
  assert.throws(() => getTheme('solarized'), /theme/);
});

test('theme: every token resolves to a well-formed SGR prefix in all 6 combinations', () => {
  for (const name of ['dark', 'light']) {
    for (const level of ['16', '256', '24bit']) {
      const t = getTheme(name, level);
      assert.deepEqual(Object.keys(t).sort(), [...EXPECTED_TOKENS].sort());
      for (const token of EXPECTED_TOKENS) {
        assert.match(t[token], /^\x1b\[[0-9;]+m$/, `${name}/${level}/${token}: ${JSON.stringify(t[token])}`);
      }
    }
  }
});
