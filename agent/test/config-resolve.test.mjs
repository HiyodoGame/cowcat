// Layered config resolution: merge precedence, canonical aliases, variable
// substitution, legacy flat-config migration, env chain, model-ref errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configModule = await import('../src/config.js');
const { loadConfig, ConfigError, displayModel, contextLimit, substitute } = configModule;

const ENV_KEYS = ['COWCAT_HOME', 'COWCAT_PROVIDER', 'CC_PROVIDER', 'COWCAT_BASE_URL', 'CC_BASE_URL',
  'COWCAT_API_KEY', 'CC_API_KEY', 'COWCAT_MODEL', 'CC_MODEL', 'COWCAT_SMALL_MODEL',
  'COWCAT_MAX_TOKENS', 'COWCAT_MAX_CONTEXT_TOKENS', 'COWCAT_CACHE', 'DEEPSEEK_API_KEY', 'MY_TEST_KEY'];

function fixture() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), 'cowcat-cfg-'));
  const proj = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
  process.env.COWCAT_HOME = home;
  for (const k of ENV_KEYS) if (k !== 'COWCAT_HOME') delete process.env[k];
  return {
    home, proj,
    writeGlobal(obj) { writeFileSync(join(home, 'config.json'), JSON.stringify(obj)); },
    writeProject(obj) { mkdirSync(join(proj, '.cowcat'), { recursive: true }); writeFileSync(join(proj, '.cowcat', 'config.json'), JSON.stringify(obj)); },
    chdirProj() { process.chdir(proj); },
    restore() {
      process.chdir(savedCwd);
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    },
  };
}

test('layering: defaults < global < project < env < overrides', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({ model: 'deepseek/deepseek-flash', maxTokens: 1111 });
    fx.writeProject({ model: 'anthropic/claude-sonnet-5-5', maxTokens: 2222 });
    fx.chdirProj();
    let cfg = loadConfig();
    assert.equal(cfg.model, 'claude-sonnet-5-5', 'project layer wins over global');
    assert.equal(cfg.maxTokens, 2222);
    process.env.COWCAT_MODEL = 'deepseek/deepseek-v4-pro';
    cfg = loadConfig();
    assert.equal(cfg.model, 'deepseek-v4-pro', 'env wins over project');
    cfg = loadConfig({ model: 'anthropic/claude-opus-5' });
    assert.equal(cfg.model, 'claude-opus-5', 'CLI overrides win over everything');
  } finally { fx.restore(); }
});

test('providers deep-merge across layers; custom provider needs protocol', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({ model: 'mygw/m', providers: { mygw: { baseURL: 'https://gw.example/v1' } } });
    fx.writeProject({ providers: { mygw: { apiKey: 'proj-key' } } });
    fx.chdirProj();
    const cfg = loadConfig();
    assert.equal(cfg.provider, 'mygw');
    assert.equal(cfg.protocol, 'openai', 'baseURL implies openai for new providers');
    assert.equal(cfg.baseURL, 'https://gw.example/v1', 'global baseURL survives project merge');
    assert.equal(cfg.apiKey, 'proj-key', 'project apiKey merged in');
    // a custom provider with neither protocol nor baseURL is rejected
    fx.writeProject({ providers: { mygw: { apiKey: 'k', baseURL: null } }, model: 'other/m' });
    fx.writeGlobal({ providers: { other: {} }, model: 'other/m' });
    assert.throws(() => loadConfig(), ConfigError);
  } finally { fx.restore(); }
});

test('canonical alias clones the source provider definition and patches it', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({
      model: 'mykimi/k2p5',
      providers: { mykimi: { canonical: 'kimi-code-plan-cn', apiKey: 'alias-key' } },
    });
    fx.chdirProj();
    const cfg = loadConfig();
    assert.equal(cfg.protocol, 'openai');
    assert.equal(cfg.baseURL, 'https://api.kimi.com/coding/v1', 'inherited from kimi-code-plan-cn preset');
    assert.equal(cfg.apiKey, 'alias-key');
    // env names are inherited too: KIMI_API_KEY feeds the alias when apiKey is absent
    fx.writeGlobal({ model: 'mykimi/k2p5', providers: { mykimi: { canonical: 'kimi-code-plan-cn' } } });
    process.env.KIMI_API_KEY = 'env-kimi-key';
    const cfg2 = loadConfig();
    assert.equal(cfg2.apiKey, 'env-kimi-key');
  } finally { fx.restore(); }
});

test('canonical alias cycles are rejected', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({
      model: 'a/m',
      providers: { a: { canonical: 'b' }, b: { canonical: 'a' } },
    });
    fx.chdirProj();
    assert.throws(() => loadConfig(), /[Cc]ircular/);
  } finally { fx.restore(); }
});

test('{env:VAR} and {file:path} substitution in provider fields', () => {
  const fx = fixture();
  try {
    process.env.MY_TEST_KEY = 'secret-from-env';
    fx.writeGlobal({
      model: 'mygw/m',
      providers: {
        mygw: { baseURL: 'https://gw.example/v1', apiKey: '{env:MY_TEST_KEY}' },
        filegw: { baseURL: 'https://f.example/v1', apiKey: '{file:creds.txt}' },
      },
    });
    writeFileSync(join(fx.home, 'creds.txt'), 'file-secret\n');
    fx.chdirProj();
    let cfg = loadConfig();
    assert.equal(cfg.apiKey, 'secret-from-env');
    cfg = loadConfig({ model: 'filegw/m' });
    assert.equal(cfg.apiKey, 'file-secret');
    // missing env var -> clear ConfigError
    delete process.env.MY_TEST_KEY;
    assert.throws(() => loadConfig(), ConfigError);
    assert.equal(substitute('plain'), 'plain', 'non-token strings pass through');
  } finally { fx.restore(); }
});

test('legacy flat config normalizes onto the matching preset provider', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat' });
    fx.chdirProj();
    const cfg = loadConfig();
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.protocol, 'openai');
    assert.equal(cfg.baseURL, 'https://api.deepseek.com');
    assert.equal(cfg.apiKey, 'k');
    assert.equal(cfg.model, 'deepseek-chat');
  } finally { fx.restore(); }
});

test('env chain keeps legacy semantics (COWCAT_* wins over CC_*)', () => {
  const fx = fixture();
  try {
    fx.chdirProj();
    process.env.CC_PROVIDER = 'deepseek';
    process.env.CC_BASE_URL = 'https://cc.example';
    process.env.CC_API_KEY = 'cc-key';
    process.env.CC_MODEL = 'cc-model';
    let cfg = loadConfig();
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.apiKey, 'cc-key');
    assert.equal(cfg.model, 'cc-model', 'custom baseURL means no catalog validation');
    process.env.COWCAT_API_KEY = 'cowcat-key';
    process.env.COWCAT_MAX_TOKENS = '12345';
    cfg = loadConfig();
    assert.equal(cfg.apiKey, 'cowcat-key');
    assert.equal(cfg.maxTokens, 12345);
    process.env.COWCAT_CACHE = 'off';
    assert.equal(loadConfig().cache, false);
  } finally { fx.restore(); }
});

test('apiKey falls back to the provider env-var list (preset + user env names)', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({ model: 'deepseek/deepseek-flash' });
    fx.chdirProj();
    assert.equal(loadConfig().apiKey, null, 'no env var set -> no key');
    process.env.DEEPSEEK_API_KEY = 'ds-env-key';
    assert.equal(loadConfig().apiKey, 'ds-env-key');
    fx.writeGlobal({
      model: 'deepseek/deepseek-flash',
      providers: { deepseek: { env: ['MY_TEST_KEY'] } },
    });
    process.env.MY_TEST_KEY = 'custom-env-key';
    assert.equal(loadConfig().apiKey, 'ds-env-key', 'preset env list has priority order');
    delete process.env.DEEPSEEK_API_KEY;
    assert.equal(loadConfig().apiKey, 'custom-env-key', 'user-added env names are searched too');
  } finally { fx.restore(); }
});

test('model ref resolution errors are clear', () => {
  const fx = fixture();
  try {
    fx.chdirProj();
    assert.throws(() => loadConfig({ model: 'nosuchprovider/m' }), ConfigError);
    assert.throws(() => loadConfig({ model: 'anthropic/no-such-model' }), /Unknown model "no-such-model".*anthropic.*provider\/model/s);
    assert.throws(() => loadConfig({ model: '/leading' }), /provider\/model/);
    assert.throws(() => loadConfig({ model: 'trailing/' }), /provider\/model/);
    // custom baseURL opts out of catalog validation
    const cfg = loadConfig({ provider: 'deepseek', baseURL: 'https://x', model: 'anything-goes' });
    assert.equal(cfg.model, 'anything-goes');
  } finally { fx.restore(); }
});

test('user model patches extend the catalog; disabled removes a preset model', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({
      model: 'deepseek/my-custom',
      providers: { deepseek: { models: { 'my-custom': { name: 'My Custom', limit: { context: 999 } } } } },
    });
    fx.chdirProj();
    let cfg = loadConfig();
    assert.equal(cfg.modelMap['my-custom'].name, 'My Custom');
    fx.writeGlobal({
      model: 'deepseek/deepseek-chat',
      providers: { deepseek: { models: { 'deepseek-chat': { disabled: true } } } },
    });
    assert.throws(() => loadConfig(), ConfigError, 'disabled preset model can no longer be selected');
  } finally { fx.restore(); }
});

test('displayModel and contextLimit use the merged catalog view', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({ model: 'anthropic/claude-sonnet-5-5' });
    fx.chdirProj();
    const cfg = loadConfig();
    assert.equal(displayModel(cfg), 'Claude Sonnet 5.5');
    assert.equal(contextLimit(cfg), cfg.modelMap['claude-sonnet-5-5'].limit.context);
    assert.equal(contextLimit({ model: 'x/y', maxContextTokens: 4242 }), 4242, 'fallback to maxContextTokens');
  } finally { fx.restore(); }
});

test('state.json wins over legacy config.json fields; installId persists to state.json', () => {
  const fx = fixture();
  try {
    fx.writeGlobal({ theme: 'dark', model: 'deepseek/deepseek-flash' });
    writeFileSync(join(fx.home, 'state.json'), JSON.stringify({ theme: 'light' }));
    fx.chdirProj();
    const cfg = loadConfig();
    assert.equal(cfg.theme, 'light', 'state.json wins');
    assert.match(cfg.installId, /^[0-9a-f]{32}$/);
    const state = JSON.parse(readFileSync(join(fx.home, 'state.json'), 'utf8'));
    assert.equal(state.installId, cfg.installId);
    assert.equal(state.theme, 'light');
  } finally { fx.restore(); }
});

test('project config discovery skips the user home config dir', () => {
  const fx = fixture();
  try {
    // a session running in a temp dir inside the home tree must not pick up
    // <home>/.cowcat/config.json as a "project" layer when COWCAT_HOME differs
    process.env.COWCAT_HOME = fx.home;
    fx.writeGlobal({ maxTokens: 777 });
    const deep = join(fx.proj, 'sub', 'dir');
    mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    const cfg = loadConfig();
    assert.equal(cfg.maxTokens, 777, 'global layer applied once');
  } finally { fx.restore(); }
});

test('resolveModelConfig: idempotent re-entry with slash-containing model ids', () => {
  // openrouter model ids contain "/" (e.g. "anthropic/claude-sonnet-5.5"); a
  // second resolveModelConfig call must not mis-split the bare id as provider/model.
  const cfg = configModule.loadConfig({ model: 'openrouter/anthropic/claude-sonnet-5.5' });
  const again = configModule.resolveModelConfig(cfg);
  assert.equal(again.provider, 'openrouter');
  assert.equal(again.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(again.modelRef, 'openrouter/anthropic/claude-sonnet-5.5');
  assert.equal(configModule.displayModel(again), 'Claude Sonnet 5.5');
  // hot-switch without syncing modelRef must still take the new model
  again.model = 'deepseek/deepseek-v4-pro';
  const switched = configModule.resolveModelConfig(again);
  assert.equal(switched.provider, 'deepseek');
  assert.equal(switched.model, 'deepseek-v4-pro');
});
