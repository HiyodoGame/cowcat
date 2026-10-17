#!/usr/bin/env node
// Probe: what is the real precedence order of the v1 config layers?
//
// Why this exists: docs/USAGE.md:23-24 publishes this chain —
//
//   默认值 < ~/.cowcat/config.json < 项目 .cowcat/config.json < 环境变量 < CLI 参数
//
// — with the CLI at the top. Reading config.js:346-385 shows one more layer applied
// *after* the CLI overrides, and it turns out to be worse than "state.json wins".
//
// readState() (config.js:97-100) merges the *global config.json* as a legacy
// fallback, and loadConfig:373 then re-applies every STATE_KEY from that merged
// object. So a key that is BOTH in the global config.json AND a STATE_KEY is
// applied twice — the second time after the project layer, after env vars, and
// after the CLI flag. Nine keys are in STATE_KEYS, and they are precisely the ones
// a team would want to share: hooks, permissions, sandbox, theme, panel,
// statusLine. A project that commits those keys gets them silently ignored.
//
// Keys that are NOT STATE_KEYS behave exactly as the documentation says. That
// asymmetry is the finding, so every scenario below states which side of it it
// probes.
//
// Each scenario builds a throwaway COWCAT_HOME and project directory and asserts
// one claim. Nothing touches the real ~/.cowcat.
//
// Usage: node tools/legacy-config-probe.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { loadConfig, STATE_KEYS } = await import(
  pathToFileURL(join(ROOT, 'agent', 'src', 'config.js')).href
);

// process.cwd() is what findProjectConfig walks from and COWCAT_HOME is what
// cowcatHome() resolves to; both are process-global, so scenarios run serially and
// each restores what it changed.
const realCwd = process.cwd();
const realHome = process.env.COWCAT_HOME;
const ENV_KEYS = ['COWCAT_PROVIDER', 'COWCAT_BASE_URL', 'COWCAT_API_KEY', 'COWCAT_MODEL',
  'COWCAT_SMALL_MODEL', 'COWCAT_MAX_TOKENS', 'COWCAT_MAX_CONTEXT_TOKENS',
  'COWCAT_CACHE', 'CC_PROVIDER', 'CC_MODEL'];
const realEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));

function scenario({ global: g, project: p, state, env = {}, cli = {} }) {
  const base = mkdtempSync(join(tmpdir(), 'cowcat-cfgprobe-'));
  const home = join(base, 'home');
  const proj = join(base, 'proj');
  mkdirSync(join(proj, '.cowcat'), { recursive: true });
  mkdirSync(home, { recursive: true });
  if (g) writeJson(join(home, 'config.json'), g);
  if (p) writeJson(join(proj, '.cowcat', 'config.json'), p);
  if (state) writeJson(join(home, 'state.json'), state);

  for (const k of ENV_KEYS) delete process.env[k];
  process.env.COWCAT_HOME = home;
  // after the wipe, not before: the wipe is what keeps a developer's real
  // COWCAT_MAX_TOKENS out of the result. (It did, once.)
  Object.assign(process.env, env);
  process.chdir(proj);

  let out;
  let error = null;
  try {
    out = loadConfig(cli);
  } catch (e) {
    error = e.message;
  } finally {
    process.chdir(realCwd);
    if (realHome === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = realHome;
    for (const k of ENV_KEYS) {
      if (realEnv[k] === undefined) delete process.env[k];
      else process.env[k] = realEnv[k];
    }
    rmSync(base, { recursive: true, force: true });
  }
  if (error) throw new Error(error);
  return out;
}

// `model` is deliberately never used as the probe key: resolveModelConfig rejects
// any value without a "provider/" prefix (config.js:280), so a synthetic model name
// fails validation before precedence is ever reached. maxTokens is a plain number
// with no post-resolution validation and is not a STATE_KEY.
const CASES = [
  {
    id: 'C1 state.json overrides the CLI flag',
    setup: { global: { sandbox: 'light' }, state: { sandbox: 'system' }, cli: { sandbox: 'off' } },
    read: (c) => c.sandbox,
    expect: 'system',
    why: 'STATE_KEYS are applied after overrides (config.js:373 follows :369)',
  },
  {
    id: 'C2 a non-STATE key does keep the CLI flag',
    setup: { global: { maxTokens: 1 }, cli: { maxTokens: 2 } },
    read: (c) => c.maxTokens,
    expect: 2,
    why: 'maxTokens is not a STATE_KEY, so it is not re-applied at :373',
  },
  {
    id: 'C3 project config beats global config (non-STATE key)',
    setup: { global: { maxTokens: 1 }, project: { maxTokens: 3 } },
    read: (c) => c.maxTokens,
    expect: 3,
    why: 'config.js:353 is applied after config.js:350 — this is what USAGE.md describes',
  },
  {
    id: 'C4 state.json beats the project config',
    setup: { project: { sandbox: 'off' }, state: { sandbox: 'light' } },
    read: (c) => c.sandbox,
    expect: 'light',
    why: 'the silent-override case: the project committed a sandbox it never gets',
  },
  {
    id: 'C5 ...and the global config.json alone also beats the project (STATE_KEY, no state.json)',
    setup: { global: { hooks: { events: ['a'] } }, project: { hooks: { events: ['b'] } } },
    read: (c) => c.hooks.events,
    expect: ['a'],
    why: 'readState() falls back to config.json (config.js:98), so :373 re-applies "a" after the project layer',
  },
  {
    id: 'C6 state.json wins over the global config.json for the same key',
    setup: { global: { hooks: { events: ['a'] } }, project: { hooks: { events: ['b'] } }, state: { hooks: { events: ['c'] } } },
    read: (c) => c.hooks.events,
    expect: ['c'],
    why: 'the spread at config.js:100 puts state.json last inside readState',
  },
  {
    id: 'C7 arrays are replaced wholesale, not concatenated',
    setup: { global: { providers: { alpha: { models: { a: {} } } } }, project: { unknownList: ['b'] }, state: {}, cli: { unknownList: ['c'] } },
    read: (c) => c.unknownList,
    expect: ['c'],
    why: 'mergeLayer assigns cfg[k] = v per top-level key (config.js:191); no array merging anywhere',
  },
  {
    id: 'C8 providers is the one deep-merged key',
    setup: { global: { providers: { alpha: { baseURL: 'https://global' } } }, project: { providers: { beta: { baseURL: 'https://project' } } } },
    read: (c) => Object.keys(c.providers ?? {}).sort().join(','),
    expect: 'alpha,beta',
    why: 'mergeProviders (config.js:137-147) exists exactly to stop the project from erasing the user table',
  },
  {
    id: 'C9 an env var beats the project config',
    setup: { project: { maxTokens: 111 }, env: { COWCAT_MAX_TOKENS: '999' } },
    read: (c) => c.maxTokens,
    expect: 999,
    why: 'config.js:355-367 is applied after the project layer',
  },
  {
    id: 'C10 the project config is found by walking up, nearest wins',
    setup: { project: { maxTokens: 7 } },
    read: () => 'found',
    expect: 'found',
    why: 'sanity check that findProjectConfig sees proj/.cowcat/config.json at all',
  },
];

let failed = 0;
for (const c of CASES) {
  let got;
  let ok = false;
  try {
    got = c.read(scenario(c.setup));
    ok = JSON.stringify(got) === JSON.stringify(c.expect);
  } catch (e) {
    got = `threw: ${e.message}`;
  }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id}`);
  console.log(`       why: ${c.why}`);
  if (!ok) console.log(`       expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
}

console.log('\n--- STATE_KEYS as declared by config.js:52 ---');
console.log(JSON.stringify(STATE_KEYS));
console.log('9 keys. USAGE.md:116 lists 7, and omits panel and sandbox.');
console.log('Every one of these 9 is re-applied AFTER the project layer, env vars and CLI.');

console.log(`\n${CASES.length - failed}/${CASES.length} expectations held`);
if (failed > 0) {
  console.error(`\n${failed} expectation(s) failed — do not cite this file's numbers in docs/research/p3-policy.md.`);
  process.exit(1);
}