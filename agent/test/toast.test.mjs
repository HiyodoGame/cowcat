// Polish phase: toast queue/timeout/variant rendering, placeholder rotation,
// and the Open Code v2 token alias table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { ToastQueue, renderToast, TOAST_DURATION_MS } from '../src/tui/toast.js';
import { getTheme, token, TOKEN_ALIASES } from '../src/tui/theme.js';
import { TuiUI } from '../src/tui/ui.js';

const theme = getTheme('dark', '256');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('toast: queue shows one current toast, extras stack as +N more', () => {
  const q = new ToastQueue({ duration: 60_000 });
  q.show({ variant: 'info', title: 'one', message: 'first' });
  assert.equal(q.current.title, 'one');
  assert.equal(q.pending, 0);
  q.show({ variant: 'success', title: 'two', message: 'second' });
  q.show({ variant: 'error', title: 'three', message: 'third' });
  assert.equal(q.current.title, 'one', 'the first toast stays current while queued');
  assert.equal(q.pending, 2);
  const { rows } = renderToast(q.current, q.pending, { colors: false });
  assert.ok(strip(rows.join('\n')).includes('+2 more'), 'queue depth rendered');
  q.dismiss();
  assert.equal(q.current.title, 'two', 'dismiss advances the queue');
  assert.equal(q.pending, 1);
  q.clear();
  assert.equal(q.current, null);
  assert.equal(q.pending, 0);
});

test('toast: auto-dismisses after its duration and chains the queue', async () => {
  const q = new ToastQueue({ duration: 30 });
  q.show({ variant: 'info', message: 'a' });
  q.show({ variant: 'info', message: 'b' });
  await sleep(60);
  assert.equal(q.current.message, 'b', 'a expired, b took over with a fresh timer');
  await sleep(60);
  assert.equal(q.current, null, 'b expired too');
  assert.equal(TOAST_DURATION_MS, 5000, 'shipped default is the OC 5s');
});

test('toast: variant-colored side bars, bold title, width cap', () => {
  const info = renderToast({ variant: 'info', title: 'Note', message: 'hello' }, 0, { colors: true, theme });
  assert.ok(info.rows[0].includes(theme.cyan), 'info bars use the feedback.info (cyan) token');
  assert.ok(info.rows[0].includes('\x1b[1m'), 'title is bold');
  assert.ok(strip(info.rows[0]).startsWith('│') && strip(info.rows[0]).endsWith('│'), 'left/right border bars');
  assert.ok(strip(info.rows[0]).includes('x'), 'dismiss affordance');

  const err = renderToast({ variant: 'error', title: 'Boom', message: 'kaput' }, 0, { colors: true, theme });
  assert.ok(err.rows[0].includes(theme.error), 'error bars use the error token');

  const long = renderToast({ variant: 'warning', title: 'T', message: 'x'.repeat(500) }, 0, { colors: true, theme, maxWidth: 60 });
  assert.ok(long.boxW <= 60, 'width capped');
  assert.ok(long.rows.length <= 5, 'message wrapped and capped');
  assert.ok(long.rows.every((r) => strip(r).length === long.boxW), 'every row exactly boxW');
});

test('toast: ui integration — esc dismisses, triggers fire, top-right paint', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.15.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  let frame = null;
  tui.screen.draw = (lines) => { frame = lines; };
  tui.start();

  // setTheme trigger (theme picker preview is excluded)
  tui.setTheme('light');
  assert.equal(tui._toasts.current.title, 'Theme');
  assert.equal(tui._toasts.current.message, 'light');

  // painted top-right: row 1, right margin 2
  tui._draw();
  const line1 = strip(frame[1]);
  assert.ok(line1.includes('Theme'), 'toast at top row');
  assert.ok(line1.endsWith('  '), 'right margin of 2 columns');
  assert.ok(frame[1].includes(tui.theme.userBubbleBg), 'toast rows sit on the raised surface');

  // esc dismisses the toast without arming an interrupt
  let hits = 0;
  tui.onInterrupt = () => { hits++; };
  tui._handleKey('\x1b');
  assert.equal(tui._toasts.current, null, 'esc dismissed the toast');
  assert.equal(hits, 0, 'esc was consumed by the toast');
  tui.close();

  // modelError / retryingIn surface as toasts
  const t2 = new TuiUI({
    input: new PassThrough(), output: new PassThrough(), colors: true, lang: 'en', version: '0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  t2.screen.enter = () => { t2.screen.active = true; };
  t2.screen.draw = () => {};
  t2.modelError('provider exploded');
  assert.equal(t2._toasts.current.variant, 'error');
  assert.ok(strip(t2._toasts.current.message).includes('provider exploded'));
  t2.retryingIn(3, 2);
  assert.equal(t2._toasts.current.variant, 'error', 'the current toast stays up');
  assert.equal(t2._toasts.pending, 1, 'retry queues behind the visible error');
  assert.equal(t2._toasts.queue[0].variant, 'warning');
  t2.close();
});

test('placeholder: rotates through the zh/en pools on focus and force', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'zh', version: '0.15.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  const first = tui._currentPlaceholder();
  assert.equal(first, '输入消息，/ 命令，@ 文件，! shell', 'index 0 is the functional hint');

  // a fresh focus must not rotate (guard against immediate flip)
  tui._placeholderAt = Date.now();
  tui.readLine();
  assert.equal(tui._currentPlaceholder(), first);

  // forced rotation (the 10s idle timer path) walks the pool and wraps
  const seen = new Set([first]);
  for (let i = 0; i < 6; i++) {
    tui._rotatePlaceholder(true);
    seen.add(tui._currentPlaceholder());
  }
  assert.ok(seen.size >= 4, `pool rotates (${seen.size} distinct)`);
  assert.equal(tui._currentPlaceholder(), first, 'wraps back to the functional hint');

  // English pool works the same
  tui.lang = 'en';
  assert.ok(tui._currentPlaceholder().length > 0);
  tui.close();
});

test('theme aliases: opencode v2 names resolve to the shipped tokens', () => {
  assert.equal(TOKEN_ALIASES['text.base'], 'text');
  assert.equal(TOKEN_ALIASES['text.muted'], 'inactive');
  assert.equal(TOKEN_ALIASES['feedback.info'], 'cyan');
  assert.equal(TOKEN_ALIASES['feedback.error'], 'error');
  assert.equal(TOKEN_ALIASES['accent.brand'], 'brand');
  assert.equal(TOKEN_ALIASES['surface.raised'], 'userBubbleBg');

  const dark = getTheme('dark', '256');
  const light = getTheme('light', '256');
  assert.equal(token(dark, 'text.muted'), dark.inactive, 'alias reads the same SGR as the concrete token');
  assert.equal(token(dark, 'feedback.warning'), dark.warning);
  assert.equal(token(light, 'accent.brand'), light.brand, 'works across palettes');
  assert.equal(token(dark, 'brand'), dark.brand, 'concrete names pass through');
  assert.equal(token(dark, 'nope.unknown'), '', 'unknown names yield empty');
  assert.equal(token(null, 'text.base'), '', 'no theme yields empty');
});
