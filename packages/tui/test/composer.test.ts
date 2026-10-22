import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRenderer, type MockInput } from '@opentui/core/testing';
import { THEME } from '../src/theme/tokens.js';
import { createScreen } from '../src/ui/screen.js';

/**
 * The composer's key bindings, pinned against a real (headless) renderer.
 *
 * The reason this file exists: ADR-104 shipped `Shift+Enter → newline` and it looked right
 * in the keymap, read right in the code, and did nothing in a real terminal — a plain
 * `{ name: 'return', shift: true }` binding only ever fires when the terminal encodes the
 * modifier, and most do not unless they implement the kitty keyboard protocol (opentui asks
 * at startup; the request can be ignored). Without that protocol Shift+Enter arrives as a
 * bare CR, which is *exactly* Enter, so the row above it submitted instead. Nothing in the
 * binding table can tell those two apart — only the terminal can.
 *
 * `meta` (Alt+Enter) is the fallback that survives the legacy encoding: it arrives as
 * ESC CR, so the modifier is visible without any protocol support. `Ctrl+J` is a literal
 * LF and needs nothing at all. Both are asserted below with `kittyKeyboard: false`, which
 * is what a terminal that ignores the protocol behaves like.
 */

interface Harness {
  readonly submit: () => readonly string[];
  readonly value: () => string;
  readonly lineCount: () => number;
  /** What `run.ts` does on every keypress (`syncInput`): the composer grows to the draft. */
  readonly sync: () => void;
  readonly keys: MockInput;
  readonly flush: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

async function harness(kittyKeyboard: boolean): Promise<Harness> {
  const { renderer, mockInput, flush, dispose } = await createTestRenderer({
    width: 80,
    height: 20,
    kittyKeyboard,
  });
  const screen = createScreen(renderer, THEME, { title: 'cowcat' });
  const submitted: string[] = [];
  screen.onSubmit((value) => {
    submitted.push(value);
  });
  screen.focus();
  await flush();
  return {
    submit: () => submitted,
    value: () => screen.inputValue(),
    lineCount: () => screen.inputLineCount(),
    sync: () => {
      screen.syncInputSize();
    },
    keys: mockInput,
    flush,
    dispose,
  };
}

test('Enter sends, and the draft is what the handler sees (ADR-104)', async () => {
  const h = await harness(true);
  try {
    await h.keys.typeText('hello');
    h.keys.pressEnter();
    await h.flush();
    assert.deepEqual(h.submit(), ['hello']);
  } finally {
    await h.dispose();
  }
});

test('Shift+Enter inserts a newline when the terminal speaks the kitty protocol', async () => {
  const h = await harness(true);
  try {
    await h.keys.typeText('one');
    h.keys.pressEnter({ shift: true });
    await h.keys.typeText('two');
    h.sync();
    await h.flush();
    assert.equal(h.value(), 'one\ntwo');
    assert.equal(h.lineCount(), 2);
    assert.deepEqual(h.submit(), [], 'Shift+Enter must not send');
  } finally {
    await h.dispose();
  }
});

test('Alt+Enter inserts a newline even when the terminal ignores the kitty protocol', async () => {
  const h = await harness(false);
  try {
    await h.keys.typeText('one');
    h.keys.pressEnter({ meta: true });
    await h.keys.typeText('two');
    h.sync();
    await h.flush();
    assert.equal(h.value(), 'one\ntwo');
    assert.equal(h.lineCount(), 2);
    assert.deepEqual(h.submit(), [], 'Alt+Enter must not send');
  } finally {
    await h.dispose();
  }
});

test('Ctrl+J inserts a newline with no protocol support at all', async () => {
  const h = await harness(false);
  try {
    await h.keys.typeText('one');
    h.keys.pressKey('j', { ctrl: true });
    await h.keys.typeText('two');
    h.sync();
    await h.flush();
    assert.equal(h.value(), 'one\ntwo');
    assert.equal(h.lineCount(), 2);
    assert.deepEqual(h.submit(), []);
  } finally {
    await h.dispose();
  }
});

test('a bare LF inserts a newline — that is what Ctrl+Enter and Ctrl+J really send (measured in Tabby)', async () => {
  // xterm-family terminals collapse Ctrl+Enter and Ctrl+J onto 0x0a, so the binding that
  // actually fires on them is `linefeed`, not `j+ctrl`. Our table spells that row out
  // instead of leaning on opentui's default.
  const h = await harness(false);
  try {
    await h.keys.typeText('one');
    h.keys.pressKey('\n');
    await h.keys.typeText('two');
    h.sync();
    await h.flush();
    assert.equal(h.value(), 'one\ntwo');
    assert.equal(h.lineCount(), 2);
    assert.deepEqual(h.submit(), []);
  } finally {
    await h.dispose();
  }
});

test('without the kitty protocol, Shift+Enter is indistinguishable from Enter — hence Alt+Enter', async () => {
  const h = await harness(false);
  try {
    await h.keys.typeText('one');
    h.keys.pressEnter({ shift: true });
    await h.flush();
    assert.deepEqual(
      h.submit(),
      ['one'],
      'this is the failure a user reported; it is the terminal, not the keymap — hence Alt+Enter',
    );
  } finally {
    await h.dispose();
  }
});
