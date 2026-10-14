// setup wizard merge + doctor checks (pure logic, importable for tests).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cowcatHome } from './config.js';

// Merge wizard answers into the existing config file, preserving fields the
// wizard does not touch (notably installId).
export function mergeSetupConfig(answers, existing = {}) {
  const next = { ...existing };
  for (const k of ['provider', 'baseURL', 'apiKey', 'model']) {
    if (answers[k] !== undefined && answers[k] !== '') next[k] = answers[k];
  }
  return next;
}

export function saveSetupConfig(answers) {
  const file = join(cowcatHome(), 'config.json');
  let existing = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { existing = {}; }
  }
  const merged = mergeSetupConfig(answers, existing);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2));
  return { file, config: merged };
}

// Doctor: config completeness + connectivity probe. `ping` is an async fn
// that resolves on success and throws on failure (count_tokens or minimal
// generate). Connectivity is only checked when a ping fn is provided.
export async function runDoctorChecks(cfg, { ping, hasConfigFile = true } = {}) {
  const items = [];
  const push = (name, ok, detail = '') => items.push({ name, ok, detail });

  push('config file', hasConfigFile, hasConfigFile ? cowcatHome() + '/config.json' : 'run `cowcat setup` first');
  push('provider', !!cfg.provider, cfg.provider || 'missing');
  push('base URL', !!cfg.baseURL, cfg.baseURL || 'missing');
  push('API key', !!cfg.apiKey, cfg.apiKey ? 'set (hidden)' : 'set COWCAT_API_KEY or run `cowcat setup`');
  push('model', !!cfg.model, cfg.model || 'missing');

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

export function doctorJson({ items, fixes = [] }) {
  return JSON.stringify({
    ok: items.every((i) => i.ok) && fixes.every((f) => !/^失败/.test(f)),
    items: items.map(({ name, ok, detail }) => ({ name, ok, detail })),
    fixes,
  }, null, 2);
}
