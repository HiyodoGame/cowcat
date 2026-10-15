// Right sidebar panel (P3): a narrow, toggleable column with live session
// vitals — context usage, model/effort, permission mode, MCP servers, and the
// todo list. Pure rendering + layout predicates only; TuiUI assembles the data
// and stitches the column onto the frame. Theme colors, dim/inactive styling.
import { padLine, truncateAnsi, ctxBar, PERM_LABELS } from './render.js';

export const SIDEBAR_WIDTH = 26;   // panel column width (excluding separator)
export const SIDEBAR_MIN_COLS = 100; // terminals narrower than this auto-hide
export const SIDEBAR_SEP = '│';     // dim border between transcript and panel

// Effective panel width for a terminal width + toggle: 0 means single-column.
export function sidebarWidth(visible, termWidth, minCols = SIDEBAR_MIN_COLS) {
  if (!visible || termWidth < minCols) return 0;
  // keep a usable transcript: below ~54 cols of main content the panel gives up
  if (termWidth - SIDEBAR_WIDTH - 1 < 54) return 0;
  return SIDEBAR_WIDTH;
}

const TODO_ICONS = { completed: '✓', in_progress: '◐', pending: '○' };

// `data`: { pct, used, max, model, effort, mode, mcp: [{name, ok}]|null,
//           todos: [{status, content}]|null }
// Returns exactly `height` rows, each padded/truncated to `width`.
export function renderSidebar(data, width, height, { theme = null, colors = true, lang = 'zh' } = {}) {
  const dim = (s) => (colors && theme?.inactive ? `${theme.inactive}${s}\x1b[0m` : s);
  const brand = (s) => (colors && theme?.brand ? `${theme.brand}${s}\x1b[0m` : s);
  const err = (s) => (colors && theme?.error ? `${theme.error}${s}\x1b[0m` : s);
  const ok = (s) => (colors && theme?.success ? `${theme.success}${s}\x1b[0m` : s);
  const row = (s) => padLine(truncateAnsi(s, width), width);
  const divider = dim('─'.repeat(Math.max(2, width - 2)));
  const label = (s) => dim(s);

  const lines = [];
  const push = (s) => { if (lines.length < height) lines.push(row(s)); };

  // --- context ---------------------------------------------------------------
  push(` ${brand('Context')}`);
  const barW = Math.max(6, Math.min(12, width - 8));
  push(` ${ctxBar(data.pct ?? 0, barW, theme)} ${Math.round(data.pct ?? 0)}%`);
  push(dim(` ${data.used ?? '?'} / ${data.max ?? '?'} tok`));
  push(divider);

  // --- model + effort ----------------------------------------------------------
  push(` ${label(lang === 'zh' ? '模型' : 'model')}`);
  push(` ${truncateAnsi(data.model || '—', width - 2)}`);
  if (data.effort) push(dim(` effort: ${data.effort}`));
  push(divider);

  // --- permission mode -----------------------------------------------------------
  push(` ${label(lang === 'zh' ? '权限' : 'mode')}`);
  {
    const m = PERM_LABELS[data.mode] ? (PERM_LABELS[data.mode][lang] ?? PERM_LABELS[data.mode].en) : (data.mode || '—');
    push(` ${m}`);
  }
  push(divider);

  // --- MCP servers ---------------------------------------------------------------
  if (data.mcp) {
    push(` ${label(`MCP (${data.mcp.length})`)}`);
    for (const s of data.mcp.slice(0, 6)) {
      const dot = s.ok === false ? err('●') : s.ok === true ? ok('●') : dim('●');
      push(` ${dot} ${truncateAnsi(s.name, width - 4)}`);
    }
    push(divider);
  }

  // --- todos ---------------------------------------------------------------------
  if (data.todos?.length) {
    push(` ${label(`todos (${data.todos.length})`)}`);
    for (const t of data.todos.slice(0, 8)) {
      const icon = TODO_ICONS[t.status] ?? '○';
      const tinted = t.status === 'completed' ? dim(icon) : t.status === 'in_progress' ? icon : dim(icon);
      push(` ${tinted} ${truncateAnsi(String(t.content ?? ''), width - 4)}`);
    }
    push(divider);
  }

  const out = lines.slice(0, height);
  while (out.length < height) out.push(' '.repeat(width));
  return out;
}

// Stitch: main rows (padded to mainW) + dim separator + sidebar rows (sbW).
export function stitchSidebar(mainLines, sidebarLines, mainW, sbW, { theme = null, colors = true } = {}) {
  const sep = colors && theme?.subtle ? `${theme.subtle}${SIDEBAR_SEP}\x1b[0m` : SIDEBAR_SEP;
  const out = [];
  const n = Math.max(mainLines.length, sidebarLines.length);
  for (let i = 0; i < n; i++) {
    const main = mainLines[i] ?? ' '.repeat(mainW);
    const side = padLine(truncateAnsi(sidebarLines[i] ?? '', sbW), sbW);
    out.push(main + sep + side);
  }
  return out;
}
