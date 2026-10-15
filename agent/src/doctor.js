// setup wizard merge + doctor checks (pure logic, importable for tests).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cowcatHome, resolveModelConfig, STATE_KEYS, writeState } from './config.js';

// Merge wizard answers into the existing config file, preserving fields the
// wizard does not touch. Two answer shapes:
//  - legacy flat: { provider, baseURL, apiKey, model } — written flat, exactly
//    like the old wizard (used by the "custom endpoint" branch);
//  - new schema: { model: "provider/model", apiKey?, baseURL?, providerId } —
//    writes the composite model ref plus a providers.<id> patch, and drops the
//    legacy flat provider/baseURL/apiKey keys (the migration moment).
// State keys (installId, theme, ...) are never written back into config.json;
// any legacy copies found there are migrated to state.json by saveSetupConfig.
export function mergeSetupConfig(answers, existing = {}) {
  const next = { ...existing };
  for (const k of STATE_KEYS) delete next[k];
  if (answers.schema !== 'providers') {
    // legacy flat answers
    for (const k of ['provider', 'baseURL', 'apiKey', 'model']) {
      if (answers[k] !== undefined && answers[k] !== '') next[k] = answers[k];
    }
    return next;
  }
  if (answers.model !== undefined) next.model = answers.model;
  const patch = {};
  if (answers.apiKey) patch.apiKey = answers.apiKey;
  if (answers.baseURL) patch.baseURL = answers.baseURL;
  const pid = answers.providerId || String(answers.model || '').split('/')[0];
  if (pid) next.providers = { ...(next.providers || {}), [pid]: { ...(next.providers?.[pid] || {}), ...patch } };
  delete next.provider;
  delete next.baseURL;
  delete next.apiKey;
  return next;
}

export function saveSetupConfig(answers) {
  const file = join(cowcatHome(), 'config.json');
  let existing = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { existing = {}; }
  }
  // Migrate any state fields found in config.json into state.json (they are
  // stripped from the config write below; losing them would be data loss).
  const stranded = {};
  for (const k of STATE_KEYS) {
    if (existing[k] !== undefined) { stranded[k] = existing[k]; delete existing[k]; }
  }
  if (Object.keys(stranded).length) {
    writeState((state) => Object.assign(state, stranded));
  }
  const merged = mergeSetupConfig(answers, existing);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2));
  return { file, config: merged };
}

// Doctor: config completeness + connectivity probe. `ping` is an async fn
// that resolves on success and throws on failure (count_tokens or minimal
// generate). Connectivity is only checked when a ping fn is provided.
// Checks follow the layered schema: the model ref must resolve, the provider
// protocol must be supported, baseURL/apiKey must be reachable (with the env
// fallback chain named when the key is missing), and the model should exist
// in the merged catalog view.
export async function runDoctorChecks(cfg, { ping, hasConfigFile = true } = {}) {
  const items = [];
  const push = (name, ok, detail = '') => items.push({ name, ok, detail });

  push('config file', hasConfigFile, hasConfigFile ? cowcatHome() + '/config.json' : 'run `cowcat setup` first');

  let view = null;
  try {
    view = resolveModelConfig({ ...cfg });
  } catch (e) {
    push('model ref', false, e.message);
  }
  if (view) {
    push('model ref', true, view.modelRef || view.model);
    push('provider', ['anthropic', 'openai'].includes(view.protocol), view.protocol ? `${view.provider} → ${view.protocol}` : 'missing');
    push('base URL', Boolean(view.baseURL), view.baseURL || 'missing');
    if (view.apiKey) {
      push('API key', true, 'set (hidden)');
    } else {
      const missing = (view.envEntry || []).filter((n) => !process.env[n]);
      push('API key', false, missing.length
        ? `set ${missing.join(' or ')} (or configure providers.${view.provider}.apiKey / run \`cowcat setup\`)`
        : 'not configured — run `cowcat setup`');
    }
    const known = Object.keys(view.modelMap || {});
    if (!view.customEndpoint && known.length && !view.modelMap[view.model]) {
      push('model catalog', false, `"${view.model}" is not in the ${view.provider} catalog (known: ${known.slice(0, 8).join(', ')}…)`);
    } else {
      push('model catalog', true, known.length ? `${known.length} models visible` : 'custom endpoint — catalog not enforced');
    }
  } else {
    push('provider', Boolean(cfg.provider), cfg.provider || 'missing');
    push('base URL', Boolean(cfg.baseURL), cfg.baseURL || 'missing');
    push('API key', Boolean(cfg.apiKey), cfg.apiKey ? 'set (hidden)' : 'set COWCAT_API_KEY or run `cowcat setup`');
    push('model catalog', false, 'model ref unresolved');
  }

  if (ping) {
    const t0 = Date.now();
    try {
      await ping();
      push('API connectivity', true, `reachable (${Date.now() - t0}ms)`);
    } catch (e) {
      push('API connectivity', false, e.message);
    }
  }
  return { items, ok: items.every((i) => i.ok) };
}

// --- P2-7: inspect / fix / --json ---------------------------------------------
import { loadRules } from './perrules.js';

function maskKey(k) {
  if (!k) return '(none)';
  return k.length <= 8 ? '••••' : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// Deep report: everything doctor knows, grouped into sections.
export function runInspect(cfg, info = {}) {
  const sections = [];
  const add = (title, lines) => sections.push({ title, lines });
  add('config', [
    `provider: ${cfg.provider}`,
    `baseURL: ${cfg.baseURL}`,
    `apiKey: ${maskKey(cfg.apiKey)}`,
    `model: ${cfg.model}`,
    `maxTokens: ${cfg.maxTokens} | maxContextTokens: ${cfg.maxContextTokens}`,
    `cache: ${cfg.cache !== false ? 'on' : 'off'} | theme: ${cfg.theme ?? 'dark'}`,
    `statusLine: ${cfg.statusLine?.command || '(none)'}`,
    `installId: ${cfg.installId ? `${cfg.installId.slice(0, 8)}…` : '(none)'}`,
  ]);
  const rules = loadRules(cfg, info.knownTools || []);
  add('permission rules', [
    ...['allow', 'deny', 'ask'].map((c) => `${c}: ${(rules[c] || []).length}`),
    ...(rules.warnings.length ? rules.warnings : []),
  ]);
  add('hooks', Object.entries(cfg.hooks || {}).map(([ev, list]) => `${ev}: ${list.length}`));
  add('state', [
    `trusted projects: ${(cfg.trustedProjects || []).length}`,
    `mcp trusted: ${(cfg.mcpTrusted || []).length}`,
    `sessions: ${info.sessionCount ?? '?'}`,
    `tools registered: ${info.toolCount ?? '?'}`,
  ]);
  if (info.extra?.length) add('extras', info.extra);
  return sections;
}

export function renderInspect(sections) {
  const out = [];
  for (const s of sections) {
    out.push(`[${s.title}]`);
    for (const l of s.lines) out.push(`  ${l}`);
  }
  return out.join('\n');
}

// Auto-fix: repair config shape without losing user data. Returns what changed.
export function runFix(cfg, { hasConfigFile, configFile, knownTools = [] } = {}) {
  const fixes = [];
  const next = { ...cfg };
  if (!hasConfigFile) { fixes.push('创建 config.json'); }
  if (!Array.isArray(next.trustedProjects)) { next.trustedProjects = []; fixes.push('补全 trustedProjects: []'); }
  if (next.permissions !== undefined && typeof next.permissions !== 'object') { next.permissions = { allow: [], deny: [], ask: [] }; fixes.push('重置非法 permissions 字段'); }
  if (next.permissions) {
    for (const col of ['allow', 'deny', 'ask']) {
      if (next.permissions[col] === undefined) next.permissions[col] = [];
    }
    // drop invalid rules (validated against knownTools; empty list passes through)
    const validated = loadRules(next, knownTools);
    for (const col of ['allow', 'deny', 'ask']) {
      const raw = next.permissions[col] || [];
      const bad = raw.length - validated[col].length;
      if (bad > 0) {
        next.permissions[col] = validated[col].map((r) => r.raw);
        fixes.push(`移除 ${col} 中 ${bad} 条坏规则`);
      }
    }
  }
  if (next.hooks !== undefined && typeof next.hooks !== 'object') { next.hooks = {}; fixes.push('重置非法 hooks 字段'); }
  if (!next.installId) fixes.push('installId 将在下次启动时生成');
  return { fixes, config: next, configFile };
}

// Auto-fix persist: split the fixed config into the config layer (written to
// config.json) and the state layer (written to state.json) so runtime state
// never leaks back into the config file.
export function saveFixedConfig(config) {
  const configLayer = { ...config };
  const stateLayer = {};
  for (const k of STATE_KEYS) {
    if (configLayer[k] !== undefined) stateLayer[k] = configLayer[k];
    delete configLayer[k];
  }
  const file = join(cowcatHome(), 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(configLayer, null, 2));
  if (Object.keys(stateLayer).length) {
    writeState((state) => Object.assign(state, stateLayer));
  }
  return file;
}

export function doctorJson({ items, fixes = [] }) {
  return JSON.stringify({
    ok: items.every((i) => i.ok) && fixes.every((f) => !/^失败/.test(f)),
    items: items.map(({ name, ok, detail }) => ({ name, ok, detail })),
    fixes,
  }, null, 2);
}
