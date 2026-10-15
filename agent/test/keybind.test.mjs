// Keybind table: chord normalization, override parsing (defaults / replace /
// unbind / unknown-name rejection), and mode-stack resolution order.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeKey, parseKeybinds, createKeymap, DEFAULT_KEYBINDS } from '../src/tui/keybind.js';

test('keybind: normalizeKey maps raw sequences to stable chord names', () => {
  assert.equal(normalizeKey('\r'), 'enter');
  assert.equal(normalizeKey('\t'), 'tab');
  assert.equal(normalizeKey('\x7f'), 'backspace');
  assert.equal(normalizeKey('\x1b'), 'escape');
  assert.equal(normalizeKey('\x1b[A'), 'up');
  assert.equal(normalizeKey('\x1b[1;2A'), 'shift+up');
  assert.equal(normalizeKey('\x1b[5~'), 'pageup');
  assert.equal(normalizeKey('\x1b[15;5~'), 'f3');
  assert.equal(normalizeKey('\x1bOj'), 'f3');
  assert.equal(normalizeKey('\x0f'), 'ctrl+o');
  assert.equal(normalizeKey('\x0a'), 'ctrl+j');
  assert.equal(normalizeKey('\x01'), 'ctrl+a');
  assert.equal(normalizeKey('\x05'), 'ctrl+e');
  assert.equal(normalizeKey('\x17'), 'ctrl+w');
  assert.equal(normalizeKey('\x1bf'), 'alt+f');
  assert.equal(normalizeKey('\x1bb'), 'alt+b');
  assert.equal(normalizeKey('\x1b[1;5C'), 'ctrl+right');
  assert.equal(normalizeKey('\x1b[13;2u'), 'shift+enter');
  assert.equal(normalizeKey('x'), 'x', 'printable characters pass through');
  assert.equal(normalizeKey('\x1b[99~'), '\x1b[99~', 'unknown sequences stay raw');
});

test('keybind: parseKeybinds returns the full default table unchanged', () => {
  const parsed = parseKeybinds();
  assert.equal(parsed.length, DEFAULT_KEYBINDS.length);
  assert.deepEqual(parsed.find((d) => d.name === 'prompt.submit').keys, ['enter']);
  assert.deepEqual(parsed.find((d) => d.name === 'approval.confirm').keys, ['enter']);
  assert.deepEqual(parsed.find((d) => d.name === 'approval.deny').keys, ['escape']);
  assert.equal(parsed.find((d) => d.name === 'card.toggle').mode, 'global');
  assert.equal(parsed.find((d) => d.name === 'approval.left').mode, 'modal');
  assert.deepEqual(parsed.find((d) => d.name === 'app.commandPalette').keys, ['ctrl+p']);
});

test('keybind: overrides replace chords by name (string, array, comma list)', () => {
  const parsed = parseKeybinds({
    'prompt.submit': 'ctrl+s',
    'scroll.up': ['ctrl+y', 'shift+up'],
    'card.toggle': 'ctrl+o,f3',
  });
  assert.deepEqual(parsed.find((d) => d.name === 'prompt.submit').keys, ['ctrl+s']);
  assert.deepEqual(parsed.find((d) => d.name === 'scroll.up'), { ...DEFAULT_KEYBINDS.find((d) => d.name === 'scroll.up'), keys: ['ctrl+y', 'shift+up'] });
  assert.deepEqual(parsed.find((d) => d.name === 'card.toggle').keys, ['ctrl+o', 'f3']);
  // untouched entries keep their defaults
  assert.deepEqual(parsed.find((d) => d.name === 'editor.kill.word').keys, ['ctrl+w']);
});

test('keybind: false and "none" unbind a command', () => {
  const parsed = parseKeybinds({ 'scroll.page.up': false, 'mode.switch': 'none' });
  assert.deepEqual(parsed.find((d) => d.name === 'scroll.page.up').keys, []);
  assert.deepEqual(parsed.find((d) => d.name === 'mode.switch').keys, []);
});

test('keybind: unknown override names throw', () => {
  assert.throws(() => parseKeybinds({ 'prompt.submitt': 'enter' }), /Unrecognized keybind/);
  assert.throws(() => parseKeybinds({ 'nope.one': 'x', 'nope.two': 'y' }), /nope\.one, nope\.two/);
});

test('keybind: keymap resolves across the mode stack, highest mode first', () => {
  const km = createKeymap();
  // 'enter' is modal (approval.confirm) and global (prompt.submit)
  assert.equal(km.resolve(['modal', 'composer', 'global'], '\r'), 'approval.confirm');
  assert.equal(km.resolve(['composer', 'global'], '\r'), 'prompt.submit');
  assert.equal(km.resolve(['global'], '\r'), 'prompt.submit');
  // modal pill navigation
  assert.equal(km.resolve(['modal'], '\x1b[D'), 'approval.left');
  assert.equal(km.resolve(['modal'], 'h'), 'approval.left');
  assert.equal(km.resolve(['modal'], '\x1b[C'), 'approval.right');
  assert.equal(km.resolve(['modal'], '\x1b'), 'approval.deny');
  // new app dialogs
  assert.equal(km.resolve(['global'], '\x10'), 'app.commandPalette');
  assert.equal(km.resolve(['global'], '\x07'), 'app.sessions');
  assert.equal(km.resolve(['global'], '?'), 'app.help');
  // composer-only binding not visible from the global layer
  assert.equal(km.resolve(['global'], '\x1b[A'), null, 'up is composer-only');
  assert.equal(km.resolve(['composer', 'global'], '\x1b[A'), 'editor.history.prev');
  // unbound commands resolve to nothing
  const custom = createKeymap({ 'scroll.page.up': false });
  assert.equal(custom.resolve(['global'], '\x1b[5~'), null);
  // raw printable keys
  assert.equal(km.resolve(['modal'], 'l'), 'approval.right');
});
