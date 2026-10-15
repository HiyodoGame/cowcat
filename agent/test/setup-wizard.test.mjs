// Phase C: preset-driven setup wizard, new-schema doctor checks, /model picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { mergeSetupConfig, runDoctorChecks, saveFixedConfig } from '../src/doctor.js';
import { runSetupWizard } from '../src/setup.js';
import { configuredProviders, readState } from '../src/config.js';
import { TuiUI } from '../src/tui/ui.js';

const ENV_KEYS = ['COWCAT_HOME', 'COWCAT_PROVIDER', 'COWCAT_BASE_URL', 'COWCAT_API_KEY', 'COWCAT_MODEL', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY'];

function fixture() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-setup-'));
  process.env.COWCAT_HOME = home;
  for (const k of ENV_KEYS) if (k !== 'COWCAT_HOME') delete process.env[k];
  return {
    home,
    configJson() {
      const f = join(home, 'config.json');
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    },
    restore() {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    },
  };
}

// Minimal line-mode UI with scripted answers.
function mockUi(lines, secrets = []) {
  const printed = [];
  const lineQueue = [...lines];
  const secretQueue = [...secrets];
  return {
    lang: 'en',
    printed,
    print: (s) => printed.push(String(s)),
    output: { write: () => {} },
    readLine: async () => (lineQueue.length ? lineQueue.shift() : null),
    readSecret: async () => (secretQueue.length ? secretQueue.shift() : null),
  };
}

// --- mergeSetupConfig: new schema ------------------------------------------------

test('mergeSetupConfig: new-schema answers write composite ref + providers patch', () => {
  const existing = { provider: 'openai', baseURL: 'https://x', apiKey: 'old', maxTokens: 5, theme: 'dark', model: 'm' };
  const merged = mergeSetupConfig({ schema: 'providers', model: 'deepseek/deepseek-flash', apiKey: 'k', providerId: 'deepseek' }, existing);
  assert.equal(merged.model, 'deepseek/deepseek-flash');
  assert.equal(merged.providers.deepseek.apiKey, 'k');
  assert.equal(merged.provider, undefined, 'legacy flat provider dropped');
  assert.equal(merged.baseURL, undefined, 'legacy flat baseURL dropped');
  assert.equal(merged.apiKey, undefined, 'legacy flat apiKey dropped');
  assert.equal(merged.maxTokens, 5, 'unrelated config fields survive');
  assert.equal(merged.theme, undefined, 'state keys never enter the config layer');
});

test('mergeSetupConfig: legacy flat answers keep the old write shape', () => {
  const merged = mergeSetupConfig({ provider: 'anthropic', baseURL: 'https://x', apiKey: 'k', model: 'm' }, { maxTokens: 5 });
  assert.equal(merged.provider, 'anthropic');
  assert.equal(merged.apiKey, 'k');
  assert.equal(merged.maxTokens, 5);
});

test('saveFixedConfig splits config layer from state layer', () => {
  const fx = fixture();
  try {
    saveFixedConfig({ provider: 'anthropic', model: 'anthropic/claude-sonnet-5-5', trustedProjects: ['/p'], theme: 'light', installId: 'abc' });
    const onDisk = JSON.parse(readFileSync(join(fx.home, 'config.json'), 'utf8'));
    assert.equal(onDisk.trustedProjects, undefined);
    assert.equal(onDisk.installId, undefined);
    assert.equal(onDisk.provider, 'anthropic');
    const state = JSON.parse(readFileSync(join(fx.home, 'state.json'), 'utf8'));
    assert.deepEqual(state.trustedProjects, ['/p']);
    assert.equal(state.installId, 'abc');
  } finally { fx.restore(); }
});

// --- setup wizard -----------------------------------------------------------------

test('setup wizard: preset flow writes the new schema to config.json', async () => {
  const fx = fixture();
  try {
    process.env.DEEPSEEK_API_KEY = 'env-ds-key'; // marks deepseek configured (✓)
    const ui = mockUi(['deepseek', '1', '1', ''], ['my-key']);
    const config = await runSetupWizard(ui);
    assert.ok(config, 'wizard completed');
    const onDisk = fx.configJson();
    assert.match(onDisk.model, /^deepseek\//, 'composite model ref');
    assert.equal(onDisk.providers.deepseek.apiKey, 'my-key');
    assert.equal(onDisk.provider, undefined, 'no legacy flat fields');
    assert.ok(ui.printed.some((l) => l.includes('DeepSeek (deepseek) ✓')), 'configured provider is marked');
    // hot-reload view: the written config resolves against the catalog
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.apiKey, 'my-key');
    assert.equal(cfg.protocol, 'openai');
  } finally { fx.restore(); }
});

test('setup wizard: custom endpoint keeps the legacy flat flow', async () => {
  const fx = fixture();
  try {
    const ui = mockUi(['custom', 'anthropic', 'https://gw.example', 'my-model', 'y'], ['k2']);
    await runSetupWizard(ui);
    const onDisk = fx.configJson();
    assert.equal(onDisk.provider, 'anthropic');
    assert.equal(onDisk.baseURL, 'https://gw.example');
    assert.equal(onDisk.apiKey, 'k2');
    assert.equal(onDisk.model, 'my-model');
  } finally { fx.restore(); }
});

test('setup wizard: EOF on the first prompt falls back to env/defaults', async () => {
  const fx = fixture();
  try {
    process.env.COWCAT_PROVIDER = 'deepseek';
    process.env.COWCAT_MODEL = 'deepseek/deepseek-v4-pro';
    process.env.DEEPSEEK_API_KEY = 'env-key';
    const ui = mockUi([], []);
    await runSetupWizard(ui);
    const onDisk = fx.configJson();
    assert.equal(onDisk.model, 'deepseek/deepseek-v4-pro');
    assert.equal(onDisk.providers.deepseek.apiKey, 'env-key', 'effective env key is persisted');
  } finally { fx.restore(); }
});

// --- doctor checks ----------------------------------------------------------------

test('doctor: unknown catalog model fails the model-ref check', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await runDoctorChecks({ provider: 'anthropic', model: 'nope' }, {});
    assert.equal(res.ok, false);
    const byName = Object.fromEntries(res.items.map((i) => [i.name, i]));
    assert.equal(byName['model ref'].ok, false);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

// --- configuredProviders ------------------------------------------------------------

test('configuredProviders marks env-keyed and apiKey-configured providers', () => {
  const fx = fixture();
  try {
    process.env.DEEPSEEK_API_KEY = 'x';
    let list = configuredProviders({});
    const ds = list.find((p) => p.id === 'deepseek');
    const anth = list.find((p) => p.id === 'anthropic');
    assert.equal(ds.configured, true, 'env var present -> configured');
    assert.equal(anth.configured, false);
    assert.ok(Object.keys(ds.models).length > 0, 'merged model view attached');
    // user-defined provider with an apiKey counts too
    list = configuredProviders({ providers: { mygw: { protocol: 'openai', baseURL: 'https://g', apiKey: 'k' } } });
    const gw = list.find((p) => p.id === 'mygw');
    assert.ok(gw, 'custom provider listed');
    assert.equal(gw.configured, true);
  } finally { fx.restore(); }
});

// --- /model picker (TUI) ------------------------------------------------------------

function headlessTui(opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.14.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({}), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
    ...opts,
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return tui;
}

test('/model (bare and with prefix) opens the picker; picking notifies onModelPick', () => {
  const fx = fixture();
  try {
    process.env.DEEPSEEK_API_KEY = 'x';
    const picked = [];
    const tui = headlessTui({ onModelPick: (ref) => picked.push(ref), getConfig: () => ({}) });
    // bare /model
    assert.equal(tui._interceptSubmit('/model'), '', 'intercepted');
    assert.equal(tui._dialogs.top.id, 'model');
    const dialog = tui._dialogs.top;
    dialog.onKey('enter');
    assert.equal(picked.length, 1);
    assert.match(picked[0], /^deepseek\//, 'first configured provider model picked');
    // with a prefix: initial query prefilters
    tui._interceptSubmit('/model flash');
    const dialog2 = tui._dialogs.top;
    assert.equal(dialog2.id, 'model');
    dialog2.onKey('enter');
    assert.equal(picked.length, 2);
    assert.match(picked[1], /^deepseek\/.*[Ff]lash/, 'prefix filtered the candidates');
  } finally { fx.restore(); }
});

test('/model picker with no configured providers shows a hint row', () => {
  const fx = fixture();
  try {
    const tui = headlessTui({ onModelPick: () => {} });
    tui._interceptSubmit('/model');
    const dialog = tui._dialogs.top;
    dialog.onKey('enter'); // hint row: must not call onModelPick or throw
    tui._dialogs.closeTop();
  } finally { fx.restore(); }
});
