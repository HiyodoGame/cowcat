// Slash-command helpers (P0-6): /cost /status /export /fork /todos /theme.
// Pure-ish functions kept here so the REPL wiring in bin stays thin.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeState } from './config.js';
import { estimateTokens } from './prompts/compact.js';

// --- usage aggregation -------------------------------------------------------

export function emptyUsage() {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
}

export function addUsage(totals, usage) {
  if (!usage) return totals;
  totals.input += usage.input_tokens || 0;
  totals.output += usage.output_tokens || 0;
  totals.cache_read += usage.cache_read_input_tokens || 0;
  totals.cache_creation += usage.cache_creation_input_tokens || 0;
  return totals;
}

// /cost report. Pricing is a deliberately rough reference (membership-quota
// style): we report tokens, not money, and label any derived number 估算.
export function formatCostReport({ model, turns, toolCalls, usage, startedAt, now = Date.now() }) {
  const mins = ((now - startedAt) / 60000).toFixed(1);
  const total = usage.input + usage.output + usage.cache_read;
  const lines = [
    `model: ${model}`,
    `turns: ${turns} | tool calls: ${toolCalls}`,
    `tokens — input: ${usage.input}  output: ${usage.output}  cache_read: ${usage.cache_read}  cache_creation: ${usage.creation ?? usage.cache_creation}`,
    `session time: ${mins} min`,
    `额度消耗参考（估算）: ${total.toLocaleString()} tokens processed`,
  ];
  return lines.join('\n');
}

// --- /status -----------------------------------------------------------------

export function maskBaseURL(url) {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch { return url.slice(0, 24) + '…'; }
}

export function formatStatus({ version, provider, baseURL, model, mode, trusted, contextUsed, contextMax, startedAt, now = Date.now() }) {
  const pct = contextMax ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : 0;
  const mins = Math.round((now - startedAt) / 60000);
  return [
    `version: cowcat/${version}`,
    `provider: ${provider}  (${maskBaseURL(baseURL)})`,
    `model: ${model}`,
    `permissions: ${mode}`,
    `folder trusted: ${trusted ? 'yes' : 'no (read-only)'}`,
    `context: ~${contextUsed.toLocaleString()} / ${contextMax.toLocaleString()} est. tokens (${pct}%)`,
    `session: ${mins} min`,
  ].join('\n');
}

// --- /export -----------------------------------------------------------------

export function exportSessionToMarkdown(sessionFile) {
  const lines = ['# CowCat session export', '', `_exported from ${sessionFile}_`, ''];
  for (const raw of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    const ts = rec.ts ? ` _(${rec.ts})_` : '';
    if (rec.type === 'checkpoint') { lines.push(`- **checkpoint #${rec.id}**${ts}`); continue; }
    if (rec.type === 'compact_boundary') { lines.push(`- **compact boundary**${ts}`, '', rec.summary, ''); continue; }
    if (rec.type === 'compacted') { lines.push(`- _(${rec.count} messages compacted)_`, ''); continue; }
    if (rec.type === 'meta') continue;
    const m = rec.message;
    if (!m) continue;
    const role = m.role === 'assistant' ? 'CowCat' : m.role;
    const parts = [];
    for (const b of m.content || []) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'tool_use') parts.push(`\`${b.name}\` ${JSON.stringify(b.input).slice(0, 200)}`);
      else if (b.type === 'tool_result') parts.push(`→ ${String(b.content).slice(0, 400)}${b.is_error ? ' (error)' : ''}`);
    }
    const body = typeof m.content === 'string' ? m.content : parts.join('\n\n');
    lines.push(`## ${role}${ts}`, '', body || '_(empty)_', '');
  }
  return lines.join('\n');
}

// --- /fork -------------------------------------------------------------------

// Copy the current session JSONL into a new session file (new id); the live
// conversation continues in the fork, the original stays untouched.
export function forkSessionFile(session, name = null) {
  const newId = name ? name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') : `${session.id}-fork`;
  const fork = Object.create(Object.getPrototypeOf(session));
  fork.cwd = session.cwd;
  fork.id = newId;
  fork.dir = session.dir;
  fork.file = join(session.dir, `${newId}.jsonl`);
  if (!existsSync(session.dir)) mkdirSync(session.dir, { recursive: true });
  copyFileSync(session.file, fork.file);
  return fork;
}

// --- /theme ------------------------------------------------------------------

export const THEMES = {
  dark: {
    name: 'dark',
    dim: '\x1b[2m', gray: '\x1b[90m', red: '\x1b[31m',
    green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
    act: '\x1b[38;5;74m', plan: '\x1b[38;5;179m', alert: '\x1b[38;5;167m',
  },
  light: {
    name: 'light',
    dim: '\x1b[2m', gray: '\x1b[90m', red: '\x1b[31m',
    green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[34m', bold: '\x1b[1m',
    act: '\x1b[34m', plan: '\x1b[38;5;94m', alert: '\x1b[31m',
  },
};

export function persistTheme(name) {
  return writeState((state) => { state.theme = name; return state; });
}

export function contextUsage(messages, maxContextTokens) {
  return { used: estimateTokens(messages), max: maxContextTokens };
}
