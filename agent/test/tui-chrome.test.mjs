// TUI chrome fixes: dialog centering/dimming frame assertions, pickOne/askSecret,
// dialog setup wizard, static OSC window title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { TuiUI } from '../src/tui/ui.js';
import { Screen } from '../src/tui/screen.js';
import { DialogSelect } from '../src/tui/dialog-select.js';
import { dialogWidth, pickDialogSize } from '../src/tui/dialog.js';
import { runSetupDialog } from '../src/setup.js';

const ENV_KEYS = ['COWCAT_HOME', 'COWCAT_PROVIDER', 'COWCAT_BASE_URL', 'COWCAT_API_KEY', 'COWCAT_MODEL', 'DEEPSEEK_API_KEY'];

function fixture() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-tui-'));
  process.env.COWCAT_HOME = home;
  for (const k of ENV_KEYS) if (k !== 'COWCAT_HOME') delete process.env[k];
  return {
    home,
    restore() {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    },
  };
}

function headlessTui(opts = {}, cols = 120, rows = 36) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = cols;
  output.rows = rows;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.14.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({}), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
    ...opts,
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  let frame = null;
  tui.screen.draw = (f) => { frame = f.slice(); };
  tui.start();
  return { tui, frame: () => frame };
}

// --- issue 4: dialog geometry ------------------------------------------------------

test('dialog frame: horizontally centered, dimmed backdrop, padTop = height/4 (120x36)', () => {
  const { tui, frame } = headlessTui();
  const ds = new DialogSelect({
    items: [{ id: 'a', title: 'alpha', description: 'first' }, { id: 'b', title: 'beta', description: 'second' }],
    pageSize: 8,
  });
  tui._openSelectDialog({ id: 'test', title: 'Geometry', ds });
  tui._drawNow();
  const f = frame();
  assert.ok(f, 'frame captured');
  const { width, height } = tui._size(); // effective frame size (rows-1 scroll guard)
  assert.equal(f.length, height, 'frame matches effective size');
  const boxW = Math.min(dialogWidth(pickDialogSize(width)), width - 2);
  const left = Math.floor((width - boxW) / 2);
  const right = width - left - boxW;
  const padTop = Math.floor(height / 4);
  // find the box band: the title row contains the dialog title
  const titleRow = f.findIndex((r) => r.includes('Geometry'));
  assert.ok(titleRow >= 0, 'title row present');
  assert.equal(titleRow, padTop, 'box starts at height/4');
  const boxLen = 1 + ds.rows(boxW).length; // title bar + content rows (no actions)
  for (let r = padTop; r < padTop + boxLen; r++) {
    assert.ok(f[r].startsWith(' '.repeat(left)), `row ${r} left pad = ${left}`);
    assert.ok(f[r].endsWith(' '.repeat(right)), `row ${r} right pad = ${right}`);
    assert.ok(!f[r].startsWith('\x1b[2m'), `row ${r} is not dimmed`);
  }
  // rows outside the box band are dimmed
  assert.ok(f[0].startsWith('\x1b[2m'), 'top row dimmed');
  assert.ok(f[padTop + boxLen].startsWith('\x1b[2m'), 'first row below the box dimmed');
  assert.ok(f[height - 1].startsWith('\x1b[2m'), 'bottom row dimmed');
  assert.ok(!f[0].includes('Geometry'), 'title not leaked onto dim rows');
});

// --- pickOne / askSecret ------------------------------------------------------------

test('pickOne resolves the picked item and closes the dialog', async () => {
  const { tui } = headlessTui();
  const p = tui.pickOne({ title: 'Pick', items: [{ id: 'x', title: 'ex' }, { id: 'y', title: 'why' }] });
  assert.equal(tui._dialogs.top.id, 'pick');
  tui._dialogs.top.onKey('down');
  tui._dialogs.top.onKey('enter');
  const item = await p;
  assert.equal(item.id, 'y');
  assert.equal(tui._dialogs.isOpen(), false, 'dialog closed after pick');
});

test('pickOne resolves null on esc (onClose path)', async () => {
  const { tui } = headlessTui();
  const p = tui.pickOne({ title: 'Pick', items: [{ id: 'x', title: 'ex' }] });
  tui._dialogs.closeTop(); // what esc does
  assert.equal(await p, null);
});

test('askSecret prompts in the composer with non-echo input', async () => {
  const { tui } = headlessTui();
  const p = tui.askSecret('API key: ');
  assert.equal(tui._promptText, 'API key: ');
  assert.equal(tui._secret, true, 'non-echo mode on');
  tui._finishRead('shh-123');
  assert.equal(await p, 'shh-123');
  assert.equal(tui._secret, false, 'non-echo mode off');
  assert.equal(tui._promptText, '');
});

// --- issue 3: dialog setup wizard ----------------------------------------------------

function mockPickerUi(picks, answers, secrets = []) {
  const printed = [];
  const toasts = [];
  return {
    lang: 'en',
    printed, toasts,
    print: (s) => printed.push(String(s)),
    toast: (variant, title, msg) => toasts.push({ variant, title, msg }),
    pickOne: async ({ items }) => {
      const next = picks.shift();
      if (next === null) return null;
      return items.find((i) => i.id === next) || null;
    },
    ask: async () => (answers.length ? answers.shift() : null),
    askSecret: async () => (secrets.length ? secrets.shift() : null),
  };
}

test('runSetupDialog: provider+model pickers, secret key, confirm — writes new schema', async () => {
  const fx = fixture();
  try {
    process.env.DEEPSEEK_API_KEY = 'env-ds-key';
    const ui = mockPickerUi(['deepseek', 'deepseek-flash'], ['y'], ['dialog-key']);
    const config = await runSetupDialog(ui);
    assert.ok(config, 'wizard completed');
    assert.equal(ui.printed.filter((l) => /^\s*\d+\./.test(l)).length, 0, 'no numbered lists in the transcript');
    const onDisk = JSON.parse(readFileSync(join(fx.home, 'config.json'), 'utf8'));
    assert.equal(onDisk.model, 'deepseek/deepseek-flash');
    assert.equal(onDisk.providers.deepseek.apiKey, 'dialog-key');
    assert.equal(onDisk.provider, undefined, 'no legacy flat fields');
    assert.ok(ui.toasts.some((t) => t.variant === 'success'), 'save notification via toast');
  } finally { fx.restore(); }
});

test('runSetupDialog: esc on the provider picker cancels without writing', async () => {
  const fx = fixture();
  try {
    const ui = mockPickerUi([null]);
    const config = await runSetupDialog(ui);
    assert.equal(config, null);
    assert.equal(existsSync(join(fx.home, 'config.json')), false, 'nothing written');
  } finally { fx.restore(); }
});

test('runSetupDialog: custom endpoint via picker fallback keeps the flat schema', async () => {
  const fx = fixture();
  try {
    const ui = mockPickerUi(['custom'], ['anthropic', 'https://gw.example', 'm'], ['ck']);
    await runSetupDialog(ui);
    const onDisk = JSON.parse(readFileSync(join(fx.home, 'config.json'), 'utf8'));
    assert.equal(onDisk.provider, 'anthropic');
    assert.equal(onDisk.baseURL, 'https://gw.example');
    assert.equal(onDisk.apiKey, 'ck');
    assert.equal(onDisk.model, 'm');
  } finally { fx.restore(); }
});

// --- issue 5: static OSC window title -------------------------------------------------

test('screen enter writes a static CowCat window title, once', () => {
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  const input = new PassThrough();
  const screen = new Screen({ input, output });
  screen.enter();
  screen.enter(); // idempotent
  assert.equal((written.match(/\x1b\]0;CowCat\x1b\\/g) || []).length, 1, 'exactly one static title write');
  assert.ok(written.includes('\x1b[?1049h'), 'alt screen still entered');
  screen.leave();
});
