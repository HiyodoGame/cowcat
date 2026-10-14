// Config resolution: env vars (COWCAT_* primary, CC_* legacy fallback) + optional ~/.cowcat/config.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let PKG_VERSION = '0.0.0';
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

const defaults = {
  provider: 'anthropic', // anthropic | openai
  baseURL: null,
  apiKey: null,
  model: 'doubao-seed-1-6-251015', // user overrides via COWCAT_MODEL
  smallModel: null,
  maxTokens: 32000,
  maxContextTokens: 100000, // estimated-token threshold that triggers compact
  timeoutMs: 300000,
  cache: true, // prompt-cache breakpoints on the anthropic provider; COWCAT_CACHE=off disables
  trustedProjects: [], // cwds the user has trusted (see src/trust.js)
};

// COWCAT_* wins; CC_* is the transitional fallback (both accepted during migration).
function envPick(env, name) {
  return env[`COWCAT_${name}`] ?? env[`CC_${name}`] ?? undefined;
}

export function loadConfig(overrides = {}) {
  const cfg = { ...defaults };
  const file = resolveStateFile('config.json');
  if (existsSync(file)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      throw new ConfigError(`Cannot parse ${file}: ${e.message}`);
    }
  }
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
  Object.assign(cfg, overrides);

  if (cfg.provider !== 'anthropic' && cfg.provider !== 'openai') {
    throw new ConfigError(`Unknown provider "${cfg.provider}" (expected anthropic|openai)`);
  }
  if (!cfg.baseURL) {
    cfg.baseURL = cfg.provider === 'anthropic'
      ? 'https://api.anthropic.com'
      : 'https://api.openai.com/v1';
  }
  cfg.version = PKG_VERSION;
  // Install-level user id: generated once, persisted into ~/.cowcat/config.json
  // so every session of this install shares it.
  if (!cfg.installId) {
    cfg.installId = randomBytes(16).toString('hex'); // 32 hex chars
    persistConfig({ ...(existsSync(resolveStateFile('config.json')) ? JSON.parse(readFileSync(resolveStateFile('config.json'), 'utf8')) : {}), installId: cfg.installId });
  }
  return cfg;
}

function persistConfig(obj) {
  const file = join(cowcatHome(), 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}
