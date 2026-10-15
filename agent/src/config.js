// Layered config resolution (Open Code style):
//   defaults < preset catalog (assets/providers.json) < ~/.cowcat/config.json
//   < project .cowcat/config.json (walking up from cwd) < COWCAT_*/CC_* env
//   < CLI overrides, with runtime state (installId, trustedProjects, mcpTrusted,
//   theme, statusLine, hooks, permissions) living in ~/.cowcat/state.json
//   (reads fall back to legacy fields still present in config.json).
//
// Providers come from the preset catalog; user config entries deep-merge onto
// presets by id, or define new providers (protocol required, defaults to openai
// when a baseURL is given). `canonical` clones another provider's resolved
// definition before patching. Model references are "provider/model"; legacy
// flat {provider, baseURL, apiKey, model} configs keep working — the flat
// endpoint fields are applied as a patch onto the resolved provider entry.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { getProvider as getPresetProvider, listProviders } from './llm/presets.js';

const require = createRequire(import.meta.url);
// Single source of truth for the version we report (CLI banner, structured
// output, and the MCP clientInfo handshake all read this).
export let PKG_VERSION = '0.0.0';
try { PKG_VERSION = require('../package.json').version; } catch { /* stay unknown */ }

export class ConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigError'; }
}

// New writes always go to ~/.cowcat; reads fall back to legacy ~/.ccagent when present.
export function cowcatHome() {
  if (process.env.COWCAT_HOME) return process.env.COWCAT_HOME;
  return join(homedir(), '.cowcat');
}

export function legacyHome() {
  return join(homedir(), '.ccagent');
}

// Read a config/state file preferring ~/.cowcat, falling back to legacy ~/.ccagent.
export function resolveStateFile(...relParts) {
  const primary = join(cowcatHome(), ...relParts);
  if (existsSync(primary)) return primary;
  const legacy = join(legacyHome(), ...relParts);
  if (existsSync(legacy)) return legacy;
  return primary; // writes and defaults target the new home
}

// Runtime state keys: stored in ~/.cowcat/state.json; legacy copies left in
// config.json are still honored on read (migration fallback).
export const STATE_KEYS = ['installId', 'trustedProjects', 'mcpTrusted', 'theme', 'statusLine', 'hooks', 'permissions', 'panel', 'sandbox'];

const DEFAULT_BASEURL = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

const defaults = {
  model: 'anthropic/claude-sonnet-5-5', // "provider/model" composite ref
  smallModel: null, // same format; falls back to `small_model` in files
  maxTokens: 32000,
  maxContextTokens: 100000, // estimated-token threshold that triggers compact
  maxParallelTools: 4, // per-turn cap for concurrent tool execution (see loop.js)
  timeoutMs: 300000,
  cache: true, // prompt-cache breakpoints on the anthropic provider; COWCAT_CACHE=off disables
  providers: {}, // user provider patches / custom providers (see header)
  // Legacy flat fields (anthropic-era configs): applied as a patch onto the
  // resolved provider entry, so old setups keep their exact semantics.
  provider: null,
  baseURL: null,
  apiKey: null,
  trustedProjects: [], // cwds the user has trusted (see src/trust.js)
  sandbox: 'light', // Bash tool sandbox: 'off' | 'light' (see src/sandbox.js);
  // 'light' = secret-stripped env + static triage + audit trail. NOT a security
  // boundary. May also be an object { envDeny: [...] } carrying extra env
  // denylist entries (exact names or '/regex/' strings); mode defaults to light.
};

function readJson(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new ConfigError(`Cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Cannot parse ${file}: ${e.message}`);
  }
}

// --- runtime state (state.json with config.json fallback) ---------------------

export function readState() {
  const legacy = readJson(resolveStateFile('config.json'));
  const state = readJson(join(cowcatHome(), 'state.json'));
  return { ...legacy, ...state }; // state.json wins
}

export function writeState(mutate) {
  const merged = readState();
  const next = mutate(structuredClone(merged)) ?? merged;
  const file = join(cowcatHome(), 'state.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

// --- variable substitution ({env:VAR} / {file:path}) --------------------------

// A string that is exactly one {env:VAR} or {file:path} token is replaced by
// the variable's value or the file's trimmed contents (opencode variable.ts
// idea). Relative file paths resolve against the layer's directory.
export function substitute(value, baseDir = process.cwd(), env = process.env) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\{(env|file):([^}]+)\}$/);
  if (!m) return value;
  const name = m[2].trim();
  if (m[1] === 'env') {
    const v = env[name];
    if (v === undefined || v === '') throw new ConfigError(`Environment variable ${name} (from {env:${name}}) is not set`);
    return v;
  }
  const file = resolvePath(baseDir || process.cwd(), name);
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (e) {
    throw new ConfigError(`Cannot read file for {file:${name}}: ${e.message}`);
  }
}

// --- layer merging ------------------------------------------------------------

function mergeProviders(base, patch) {
  const out = { ...(base || {}) };
  for (const [id, p] of Object.entries(patch || {})) {
    if (!p || typeof p !== 'object') continue;
    const prev = out[id] || {};
    const merged = { ...prev, ...p };
    if (prev.models || p.models) merged.models = mergeModelPatch(prev.models, p.models);
    out[id] = merged;
  }
  return out;
}

// Models patch over preset models (an array) or prior map entries. Result is an
// object map keyed by model id once any patch exists.
function mergeModelPatch(baseModels, patchModels) {
  if (!patchModels || typeof patchModels !== 'object') return baseModels;
  const map = {};
  if (Array.isArray(baseModels)) {
    for (const m of baseModels) if (m && m.id) map[m.id] = m;
  } else if (baseModels && typeof baseModels === 'object') {
    Object.assign(map, baseModels);
  }
  for (const [id, m] of Object.entries(patchModels)) {
    if (m && typeof m === 'object' && map[id]) map[id] = { ...map[id], ...m };
    else map[id] = m ?? null;
  }
  return map;
}

function substituteProviderStrings(providers, baseDir) {
  const out = {};
  for (const [id, e] of Object.entries(providers || {})) {
    if (!e || typeof e !== 'object') continue;
    const e2 = { ...e };
    for (const f of ['name', 'protocol', 'baseURL', 'apiKey', 'canonical', 'doc']) {
      if (typeof e2[f] === 'string') e2[f] = substitute(e2[f], baseDir);
    }
    out[id] = e2;
  }
  return out;
}

// Merge one layer (config file / env-shaped object / CLI overrides) into cfg.
// Unknown keys pass through verbatim (theme, permissions, custom keys, ...).
function mergeLayer(cfg, layer, baseDir) {
  for (const [k, v] of Object.entries(layer || {})) {
    if (v === undefined) continue;
    if (k === 'providers') {
      cfg.providers = mergeProviders(cfg.providers, substituteProviderStrings(v, baseDir));
    } else if (k === 'small_model') {
      cfg.smallModel = v;
    } else if (k === 'version') {
      continue; // rebuilt after resolution
    } else {
      cfg[k] = typeof v === 'string' ? substitute(v, baseDir) : v;
    }
  }
}

// Project config: nearest .cowcat/config.json found walking up from cwd. The
// user-level config dir (~/.cowcat, i.e. cowcatHome) is skipped — it is the
// global layer, not a project — so sessions run inside the home tree do not
// double-load it.
function findProjectConfig(startDir) {
  const globalFile = resolvePath(resolveStateFile('config.json'));
  // The user's home config dir is the global layer under any COWCAT_HOME.
  const homeConfig = resolvePath(join(homedir(), '.cowcat', 'config.json'));
  let dir = resolvePath(startDir);
  while (true) {
    const file = join(dir, '.cowcat', 'config.json');
    const abs = resolvePath(file);
    if (existsSync(file) && abs !== globalFile && abs !== homeConfig) return file;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// COWCAT_* wins; CC_* is the transitional fallback (both accepted during migration).
function envPick(env, name) {
  return env[`COWCAT_${name}`] ?? env[`CC_${name}`] ?? undefined;
}

// --- provider entry resolution (canonical aliases, presets, user patches) ------

function resolveProviderEntry(providers, id, seen = new Set()) {
  const own = providers[id];
  if (!own) return getPresetProvider(id); // pure preset entry
  if (seen.has(id)) throw new ConfigError(`Circular canonical provider alias: ${[...seen, id].join(' -> ')}`);
  seen.add(id);
  const { canonical, ...patch } = own;
  const base = canonical
    ? resolveProviderEntry(providers, canonical, seen)
    : getPresetProvider(id);
  const entry = { ...(base || {}), ...patch };
  entry.env = [...new Set([...(Array.isArray(base?.env) ? base.env : []), ...(Array.isArray(patch.env) ? patch.env : [])])];
  entry.models = mergeModelPatch(base?.models, patch.models);
  entry.id = id;
  return entry;
}

// Preset models (array) overlaid with user model patches (map); `disabled`
// removes a preset model from the merged view.
function mergedModelMap(entry, preset) {
  const map = {};
  if (preset && Array.isArray(preset.models)) {
    for (const m of preset.models) if (m && m.id) map[m.id] = m;
  }
  const userModels = entry?.models;
  if (userModels && !Array.isArray(userModels) && typeof userModels === 'object') {
    for (const [id, m] of Object.entries(userModels)) {
      if (m && m.disabled) { delete map[id]; continue; }
      map[id] = m && typeof m === 'object' ? { ...(map[id] || { id }), ...m, id } : (m ?? { id });
    }
  }
  return map;
}

function splitModelRef(ref) {
  const slash = ref.indexOf('/');
  if (slash === 0 || slash === ref.length - 1) return null;
  return slash > 0 ? [ref.slice(0, slash), ref.slice(slash + 1)] : [null, ref];
}

// Resolve the effective provider/model/protocol/baseURL/apiKey for a config
// object. Idempotent: safe to call again on an already-resolved cfg. Mutates
// and returns cfg, adding: provider, protocol, baseURL, apiKey, model (bare id),
// modelRef (original), modelMap (merged catalog view).
export function resolveModelConfig(cfg) {
  let ref = String(cfg.model ?? '');
  // Idempotency: when re-entering with an already-resolved cfg, the model field
  // holds the BARE model id, which may itself contain "/" (e.g. openrouter's
  // "anthropic/claude-sonnet-5.5") and would be mis-split as a provider prefix.
  // Reuse the originally parsed modelRef when the bare-id match proves we
  // already resolved this config. A stale modelRef after an external model swap
  // never matches (model ≠ saved mid), so hot-switch paths stay unaffected.
  if (typeof cfg.modelRef === 'string' && cfg.modelRef && cfg.provider) {
    const saved = splitModelRef(cfg.modelRef);
    if (saved && saved[1] === cfg.model) ref = cfg.modelRef;
    else if (cfg.modelRef === cfg.model) ref = cfg.modelRef;
  }
  if (!ref) throw new ConfigError('No model configured — set model to "provider/model" (e.g. "anthropic/claude-sonnet-5-5")');
  const parts = splitModelRef(ref);
  if (!parts) throw new ConfigError(`Invalid model reference "${ref}" — expected "provider/model"`);
  let [pid, mid] = parts;
  if (!pid) {
    pid = cfg.provider || null;
    if (!pid) throw new ConfigError(`Model "${mid}" has no provider prefix and no provider is configured — use "provider/${mid}" or set provider`);
  }
  if (!mid) throw new ConfigError(`Invalid model reference "${ref}" — missing model id`);

  const providers = mergeProviders({}, cfg.providers);
  // Legacy flat endpoint fields patch the active provider (back-compat).
  const legacyPatch = {};
  if (cfg.baseURL) legacyPatch.baseURL = cfg.baseURL;
  if (cfg.apiKey) legacyPatch.apiKey = cfg.apiKey;
  if (Object.keys(legacyPatch).length) {
    providers[pid] = mergeProviders({ [pid]: providers[pid] || {} }, { [pid]: legacyPatch })[pid];
  }

  const entry = resolveProviderEntry(providers, pid);
  if (!entry) {
    throw new ConfigError(`Unknown provider "${pid}". Use a preset id (see /status presets) or define providers.${pid} in ~/.cowcat/config.json`);
  }
  let protocol = entry.protocol || null;
  if (!protocol && entry.baseURL) protocol = 'openai'; // custom endpoint default
  if (!protocol) {
    throw new ConfigError(`providers.${pid} needs a "protocol" (anthropic|openai) — or give it a baseURL to default to openai`);
  }
  if (protocol !== 'anthropic' && protocol !== 'openai') {
    throw new ConfigError(`providers.${pid}: unsupported protocol "${protocol}" (expected anthropic|openai)`);
  }

  const preset = getPresetProvider(pid);
  const baseURL = entry.baseURL || entry.api || DEFAULT_BASEURL[protocol];

  // apiKey: explicit config wins; otherwise the first non-empty env var from
  // the merged env list (preset env names + user-added env names).
  let apiKey = entry.apiKey || null;
  if (!apiKey) {
    for (const name of entry.env || []) {
      const v = process.env[name];
      if (v) { apiKey = v; break; }
    }
  }

  // Model validation against the merged catalog view. Skipped when a custom
  // baseURL is in play — gateways serve model names the catalog cannot know.
  const modelMap = mergedModelMap(entry, preset);
  if (!entry.baseURL && Object.keys(modelMap).length > 0 && !modelMap[mid]) {
    const known = Object.keys(modelMap);
    const hint = known.slice(0, 8).join(', ') + (known.length > 8 ? ', …' : '');
    throw new ConfigError(`Unknown model "${mid}" for provider "${pid}" (available: ${hint}). Use "provider/model" format or define providers.${pid}.models."${mid}"`);
  }

  cfg.provider = pid;
  cfg.protocol = protocol;
  cfg.baseURL = baseURL;
  cfg.apiKey = apiKey;
  cfg.model = mid;
  cfg.modelRef = ref;
  cfg.modelMap = modelMap;
  cfg.envEntry = Array.isArray(entry.env) ? entry.env : [];
  cfg.customEndpoint = Boolean(entry.baseURL); // user baseURL: catalog not enforced
  return cfg;
}

// --- public API ---------------------------------------------------------------

export function loadConfig(overrides = {}) {
  const cfg = structuredClone(defaults);

  const globalFile = resolveStateFile('config.json');
  if (existsSync(globalFile)) mergeLayer(cfg, readJson(globalFile), dirname(globalFile));

  const projFile = findProjectConfig(process.cwd());
  if (projFile) mergeLayer(cfg, readJson(projFile), dirname(projFile));

  const env = process.env;
  const ENV_MAP = {
    PROVIDER: 'provider', BASE_URL: 'baseURL', API_KEY: 'apiKey', MODEL: 'model',
    SMALL_MODEL: 'smallModel', MAX_TOKENS: 'maxTokens',
    MAX_CONTEXT_TOKENS: 'maxContextTokens',
  };
  for (const [envName, key] of Object.entries(ENV_MAP)) {
    const v = envPick(env, envName);
    if (v === undefined) continue;
    cfg[key] = (envName === 'MAX_TOKENS' || envName === 'MAX_CONTEXT_TOKENS') ? Number(v) : v;
  }
  const cacheFlag = envPick(env, 'CACHE');
  if (cacheFlag === 'off' || cacheFlag === 'false' || cacheFlag === '0') cfg.cache = false;

  if (overrides && typeof overrides === 'object') mergeLayer(cfg, overrides, process.cwd());

  // Runtime state: state.json wins, legacy config.json fields still honored.
  const state = readState();
  for (const k of STATE_KEYS) if (state[k] !== undefined) cfg[k] = state[k];

  resolveModelConfig(cfg);

  // Install-level user id: generated once, persisted into ~/.cowcat/state.json
  // so every session of this install shares it.
  if (!cfg.installId) {
    cfg.installId = randomBytes(16).toString('hex'); // 32 hex chars
    writeState((s) => { s.installId = cfg.installId; return s; });
  }
  cfg.version = PKG_VERSION;
  return cfg;
}

// Display name for the configured model: catalog name when known, else the id.
export function displayModel(cfg) {
  try {
    const view = resolveModelConfig({ ...cfg });
    return view.modelMap[view.model]?.name || view.model;
  } catch {
    return cfg.modelRef || cfg.model || '';
  }
}

// Effective context window: the resolved model's catalog limit.context, falling
// back to maxContextTokens (the compact threshold) when unknown.
export function contextLimit(cfg) {
  try {
    const view = resolveModelConfig({ ...cfg });
    const limit = view.modelMap[view.model]?.limit;
    return (limit && typeof limit.context === 'number') ? limit.context : cfg.maxContextTokens;
  } catch {
    return cfg.maxContextTokens;
  }
}

// Resolved descriptions of every known provider (presets + user-defined),
// for pickers and diagnostics. `configured` means an apiKey is set or one of
// the provider's env vars is present. `models` is the merged id -> model map.
export function configuredProviders(cfg = {}) {
  const userProviders = mergeProviders({}, (cfg && cfg.providers) || {});
  const seen = new Set();
  const out = [];
  const push = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    let entry;
    try {
      entry = resolveProviderEntry(userProviders, id);
    } catch {
      return; // broken canonical chain: skip
    }
    if (!entry) return;
    const preset = getPresetProvider(id);
    const env = Array.isArray(entry.env) ? entry.env : [];
    out.push({
      id,
      name: entry.name || id,
      protocol: entry.protocol || null,
      doc: entry.doc || null,
      env,
      envReady: env.some((n) => process.env[n]),
      apiKey: entry.apiKey || null,
      baseURL: entry.baseURL || entry.api || null,
      configured: Boolean(entry.apiKey) || env.some((n) => process.env[n]),
      models: mergedModelMap(entry, preset),
    });
  };
  for (const p of listProviders()) push(p.id);
  for (const id of Object.keys(userProviders)) push(id);
  return out;
}
