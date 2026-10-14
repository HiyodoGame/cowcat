// Pure TUI rendering core: layout math, ANSI-aware truncation/wrapping, header
// and status bar builders, and the tool-card state machine. No side effects —
// everything here is unit-testable without a terminal.
import { stringWidth, graphemes, charWidth } from './wcwidth.js';

export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_TOKEN_RE = /^\x1b\[[0-9;?]*[A-Za-z]/;
const CTRL_RE = /[\x00-\x1f\x7f]/;

// Split an ANSI-bearing line into tokens: escape sequences or grapheme
// clusters with their display widths. Control characters are dropped.
function tokensOf(line) {
  const toks = [];
  const s = String(line);
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = ANSI_TOKEN_RE.exec(s.slice(i));
      if (m) { toks.push({ ansi: m[0] }); i += m[0].length; }
      else { toks.push({ ansi: s[i] }); i++; }
      continue;
    }
    const nextEsc = s.indexOf('\x1b', i);
    const chunk = nextEsc === -1 ? s.slice(i) : s.slice(i, nextEsc);
    for (const g of graphemes(chunk)) {
      if (CTRL_RE.test(g)) continue;
      toks.push({ ch: g, w: charWidth(g) });
    }
    i += chunk.length;
  }
  return toks;
}

export function visibleLen(s) {
  return stringWidth(String(s).replace(ANSI_RE, '').replace(CTRL_RE, ''));
}

// Width-aware truncate that preserves ANSI sequences (drops whole sequences,
// never splits one). Fill semantics: a wide cluster that starts before the
// width limit is kept whole, so the result may exceed width by one column.
export function truncateAnsi(line, width) {
  if (visibleLen(line) <= width) return line;
  let out = '';
  let w = 0;
  for (const t of tokensOf(line)) {
    if (t.ansi) { out += t.ansi; continue; }
    if (w >= width) break;
    out += t.ch;
    w += t.w;
  }
  return out + '\x1b[0m';
}

export function padLine(line, width) {
  const len = visibleLen(line);
  return len >= width ? truncateAnsi(line, width) : line + ' '.repeat(width - len);
}

// Extract the SGR state still active at the end of a line, for prefixing a
// wrapped continuation so its style matches the line it was cut from.
export function ansiStateCarry(line) {
  const active = [];
  const isFg = (p) => (p >= 30 && p <= 37) || p === 38 || (p >= 90 && p <= 97);
  const isBg = (p) => (p >= 40 && p <= 47) || p === 48 || (p >= 100 && p <= 107);
  const OFF = { 22: [1, 2], 23: [3], 24: [4], 25: [5, 6], 27: [7], 28: [8], 29: [9] };
  for (const m of String(line).matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = m[1] === '' ? [0] : m[1].split(';').map((p) => (p === '' ? 0 : Number(p)));
    if (params.includes(0)) { active.length = 0; continue; }
    for (const p of params) {
      if (Number.isNaN(p)) continue;
      if (p === 39) { for (let k = active.length - 1; k >= 0; k--) if (isFg(active[k])) active.splice(k, 1); continue; }
      if (p === 49) { for (let k = active.length - 1; k >= 0; k--) if (isBg(active[k])) active.splice(k, 1); continue; }
      const off = OFF[p];
      if (off) { for (let k = active.length - 1; k >= 0; k--) if (off.includes(active[k])) active.splice(k, 1); continue; }
      if (!active.includes(p)) active.push(p);
    }
  }
  return active.length ? `\x1b[${active.join(';')}m` : '';
}

const joinToks = (toks) => toks.map((t) => t.ansi || t.ch).join('');

// Greedy wrap honoring existing newlines. Breaks after the last space that
// fits; otherwise hard-cuts at the width boundary (whole clusters only).
// Continuation lines are prefixed with the carried SGR state.
export function wrapText(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (visibleLen(line) > width) {
      const toks = tokensOf(line);
      let w = 0, cut = -1, i = 0;
      for (; i < toks.length; i++) {
        const t = toks[i];
        if (t.ansi) continue;
        if (w + t.w > width) break;
        w += t.w;
        if (t.ch === ' ') cut = i;
      }
      let emitEnd, restStart;
      if (cut >= 0) { emitEnd = cut; restStart = cut + 1; }
      else {
        if (i === 0) i = toks.findIndex((t) => !t.ansi) + 1 || 1;
        emitEnd = i; restStart = i;
      }
      const head = toks.slice(0, emitEnd);
      out.push(joinToks(head) + '\x1b[0m');
      line = ansiStateCarry(joinToks(head)) + joinToks(toks.slice(restStart));
    }
    out.push(line);
  }
  return out;
}

// Remove the first n display columns from an ANSI-bearing line (whole
// clusters only, so up to n + 1 columns may be removed).
export function stripFirstChars(line, n) {
  const toks = tokensOf(line);
  let removed = 0;
  let idx = 0;
  for (; idx < toks.length; idx++) {
    const t = toks[idx];
    if (t.ansi) continue;
    if (removed + t.w > n) break;
    removed += t.w;
  }
  let pendingAnsi = '';
  let out = '';
  for (; idx < toks.length; idx++) {
    const t = toks[idx];
    if (t.ansi) { pendingAnsi += t.ansi; continue; }
    out += pendingAnsi + t.ch;
    pendingAnsi = '';
  }
  return out;
}

export const CTX_COLORS = { ok: '\x1b[32m', warn: '\x1b[33m', crit: '\x1b[31m', reset: '\x1b[0m', dim: '\x1b[2m' };

export function ctxBar(pct, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const color = pct >= 90 ? CTX_COLORS.crit : pct >= 70 ? CTX_COLORS.warn : CTX_COLORS.ok;
  return `${color}${'█'.repeat(filled)}${CTX_COLORS.dim}${'░'.repeat(width - filled)}${CTX_COLORS.reset}`;
}

// Header: compact banner row + context meter + model/mode. Returns ≤3 lines.
export function renderHeader({ bannerLines = [], pct = 0, model = '', mode = 'default', plan = null, width }) {
  const lines = [];
  const meter = `${ctxBar(pct)} ${pct}%`;
  const right = `${model} [${mode}]${plan ? ` ${plan}` : ''}`;
  const banner = bannerLines.length ? bannerLines[0] : 'CowCat';
  const gap = width - visibleLen(banner) - visibleLen(meter) - visibleLen(right) - 4;
  lines.push(padLine(`${banner}  ${meter}${gap > 0 ? ' '.repeat(gap) : '  '}${right}`, width));
  if (bannerLines.length > 1) lines.push(padLine(bannerLines[1], width));
  return lines.slice(0, 3);
}

export function renderStatus({ cost = '', version = '', cwd = '', mode = '' }, width) {
  const left = ` ${cost}`;
  const mid = ` cowcat/${version} ${mode}`;
  const right = cwd;
  const gap1 = Math.max(1, width - visibleLen(left) - visibleLen(mid) - visibleLen(right) - 3);
  return padLine(`${left}${' '.repeat(gap1)}${mid}${' '.repeat(Math.max(1, width - visibleLen(left) - gap1 - visibleLen(mid) - visibleLen(right)))}${right}`, width);
}

// --- transcript entries -------------------------------------------------------

// A tool card goes: running (spinner) -> done | error. Folded by default; the
// user expands with a key, and /diff-style expansion is handled by the caller.
export function createCard(kind, title) {
  return { kind, title, status: 'running', summaryLines: [], fullLines: [], expanded: false };
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function renderCard(card, { width, spinFrame = 0, colors = true } = {}) {
  const C = { green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m' };
  const p = (c, s) => (colors ? `${c}${s}${C.reset}` : s);
  if (card.status === 'running') {
    const spin = SPINNER[spinFrame % SPINNER.length];
    const body = card.summaryLines.length ? card.summaryLines[0] : '';
    return [padLine(`${p(C.cyan, spin)} ${card.title}${body ? ` — ${truncateAnsi(body, Math.max(10, width - visibleLen(card.title) - 6))}` : ''}`, width)];
  }
  const mark = card.status === 'error' ? p(C.red, '✗') : p(C.green, '✓');
  const lines = [padLine(`${mark} ${card.title}`, width)];
  const shown = card.expanded ? card.fullLines : card.summaryLines;
  for (const l of shown.slice(0, card.expanded ? 30 : 3)) {
    lines.push(padLine(`  ${p(C.gray, '│')} ${truncateAnsi(l, width - 4)}`, width));
  }
  if (!card.expanded && card.fullLines.length > 3) {
    lines.push(padLine(`  ${p(C.gray, '│')} ··· (${card.fullLines.length} lines) ···`, width));
  }
  return lines;
}

// Final screen assembly: fixed header, scrolling transcript window, input box,
// status line. Returns exactly `height` padded lines.
export function buildScreen({ header = [], transcript = [], input = [], status = '', width, height, scroll = 0 }) {
  const transH = Math.max(1, height - header.length - input.length - 1);
  const off = scrollClamp(transcript.length, transH, scroll);
  const window = [];
  for (let i = 0; i < transH; i++) {
    const line = transcript[off + i];
    window.push(line === undefined ? ' '.repeat(width) : padLine(truncateAnsi(line, width), width));
  }
  const body = [
    ...header.map((l) => padLine(truncateAnsi(l, width), width)),
    ...window,
    ...input.map((l) => padLine(truncateAnsi(l, width), width)),
  ];
  while (body.length < height - 1) body.splice(header.length + window.length, 0, ' '.repeat(width));
  body.push(padLine(truncateAnsi(status, width), width));
  return body.slice(0, height);
}

export function scrollClamp(transcriptCount, transHeight, scroll) {
  return Math.max(0, Math.min(scroll, Math.max(0, transcriptCount - transHeight)));
}
