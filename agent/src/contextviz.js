// /context visualization: token occupancy per message section, share bars,
// and threshold warnings. Estimation reuses the chars/4 heuristic.
import { estimateTokens } from './prompts/compact.js';

export function analyzeContext(messages, maxTokens, { systemBlocks = [] } = {}) {
  let systemTokens = 0;
  for (const s of systemBlocks) systemTokens += Math.ceil(String(s).length / 4);
  let total = systemTokens;
  const perMessage = messages.map((m, i) => {
    const est = estimateTokens([m]);
    total += est;
    return { index: i, role: m.role, tokens: est };
  });
  // group contiguous runs of the same role into sections
  const sections = [];
  for (const pm of perMessage) {
    const last = sections[sections.length - 1];
    if (last && last.role === pm.role) {
      last.tokens += pm.tokens;
      last.end = pm.index;
    } else {
      sections.push({ role: pm.role, tokens: pm.tokens, start: pm.index, end: pm.index });
    }
  }
  const byRole = {};
  for (const pm of perMessage) byRole[pm.role] = (byRole[pm.role] || 0) + pm.tokens;
  const largest = [...perMessage].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  const pct = maxTokens ? Math.round((total / maxTokens) * 100) : 0;
  return {
    total, maxTokens, pct, systemTokens, sections, byRole, largest, messageCount: messages.length,
    warning: pct >= 90 ? 'critical' : pct >= 70 ? 'high' : null,
  };
}

const BAR_WIDTH = 28;

export function renderContextReport(a, { colors = true } = {}) {
  const C = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m' };
  const paint = (c, s) => (colors ? `${c}${s}${C.reset}` : s);
  const lines = [];
  lines.push(`context: ~${a.total.toLocaleString()} / ${a.maxTokens.toLocaleString()} est. tokens (${a.pct}%)`);
  if (a.warning) {
    const c = a.warning === 'critical' ? C.red : C.yellow;
    lines.push(paint(c, a.warning === 'critical' ? '⚠ 接近上限：compact 即将触发' : '▲ 用量偏高（70%+），注意控制输出'));
  }
  lines.push('');
  if (a.systemTokens) lines.push(`${paint(C.cyan, 'system')}   ${bar(a.systemTokens, a.total)} ${a.systemTokens.toLocaleString()}`);
  for (const role of Object.keys(a.byRole)) {
    lines.push(`${paint(C.cyan, role.padEnd(7))} ${bar(a.byRole[role], a.total)} ${a.byRole[role].toLocaleString()}`);
  }
  lines.push('');
  lines.push('sections (oldest → newest):');
  const maxSection = Math.max(1, ...a.sections.map((s) => s.tokens));
  for (const s of a.sections.slice(-12)) {
    const w = Math.max(1, Math.round((s.tokens / maxSection) * BAR_WIDTH));
    lines.push(`  #${s.start}${s.end > s.start ? `-${s.end}` : ''} ${s.role.padEnd(9)} ${paint(C.gray, '█'.repeat(w))} ${s.tokens}`);
  }
  if (a.sections.length > 12) lines.push(`  … ${a.sections.length - 12} more sections`);
  lines.push('');
  lines.push('largest messages:');
  for (const m of a.largest) {
    lines.push(`  #${m.index} ${m.role} — ~${m.tokens.toLocaleString()} tokens`);
  }
  return lines;

  function bar(v, total) {
    const w = Math.max(1, Math.round((v / Math.max(1, total)) * BAR_WIDTH));
    const c = a.pct >= 90 ? C.red : a.pct >= 70 ? C.yellow : C.green;
    return paint(c, '█'.repeat(w));
  }
}
