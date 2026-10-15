// Pure TUI rendering core: layout math, ANSI-aware truncation/wrapping, header
// and status bar builders, and the tool-card state machine. No side effects —
// everything here is unit-testable without a terminal.
import { stringWidth, graphemes, charWidth } from './wcwidth.js';

export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_TOKEN_RE = /^\x1b\[[0-9;?]*[A-Za-z]/;
const CTRL_RE = /[\x00-\x1f\x7f]/g;

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
      if (g.match(CTRL_RE)) continue;
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
  const head = (p) => (typeof p === 'object' ? p[0] : p);
  const isFg = (p) => (p >= 30 && p <= 37) || p === 38 || (p >= 90 && p <= 97);
  const isBg = (p) => (p >= 40 && p <= 47) || p === 48 || (p >= 100 && p <= 107);
  const OFF = { 22: [1, 2], 23: [3], 24: [4], 25: [5, 6], 27: [7], 28: [8], 29: [9] };
  for (const m of String(line).matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = m[1] === '' ? [0] : m[1].split(';').map((p) => (p === '' ? 0 : Number(p)));
    if (params.includes(0)) { active.length = 0; continue; }
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (Number.isNaN(p)) continue;
      if (p === 38 || p === 48) {
        // extended color: mode + args form one unit, cleared wholesale by 39/49
        const mode = params[i + 1];
        const argc = mode === 5 ? 3 : mode === 2 ? 5 : 2;
        const unit = params.slice(i, i + argc);
        for (let k = active.length - 1; k >= 0; k--) {
          if (typeof active[k] === 'object' && active[k][0] === p) active.splice(k, 1);
        }
        active.push(unit);
        i += argc - 1;
        continue;
      }
      if (p === 39) { for (let k = active.length - 1; k >= 0; k--) if (isFg(head(active[k]))) active.splice(k, 1); continue; }
      if (p === 49) { for (let k = active.length - 1; k >= 0; k--) if (isBg(head(active[k]))) active.splice(k, 1); continue; }
      const off = OFF[p];
      if (off) { for (let k = active.length - 1; k >= 0; k--) if (off.includes(active[k])) active.splice(k, 1); continue; }
      if (!active.includes(p)) active.push(p);
    }
  }
  return active.length
    ? `\x1b[${active.map((a) => (typeof a === 'object' ? a.join(';') : a)).join(';')}m`
    : '';
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

export function ctxBar(pct, width = 20, theme = null) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const ok = theme?.success ?? CTX_COLORS.ok;
  const warn = theme?.warning ?? CTX_COLORS.warn;
  const crit = theme?.error ?? CTX_COLORS.crit;
  const color = pct >= 90 ? crit : pct >= 70 ? warn : ok;
  return `${color}${'█'.repeat(filled)}${CTX_COLORS.dim}${'░'.repeat(width - filled)}${CTX_COLORS.reset}`;
}

// Header: compact banner row + context meter + model/mode. Returns ≤3 lines.
export function renderHeader({ bannerLines = [], pct = 0, model = '', mode = 'default', plan = null, width, theme = null }) {
  const lines = [];
  const meter = `${ctxBar(pct, 20, theme)} ${pct}%`;
  const right = `${model} [${mode}]${plan ? ` ${plan}` : ''}`;
  const banner = bannerLines.length ? bannerLines[0] : 'CowCat';
  const gap = width - visibleLen(banner) - visibleLen(meter) - visibleLen(right) - 4;
  lines.push(padLine(`${banner}  ${meter}${gap > 0 ? ' '.repeat(gap) : '  '}${right}`, width));
  if (bannerLines.length > 1) lines.push(padLine(bannerLines[1], width));
  return lines.slice(0, 3);
}

// Status bar as chips: [cost] [perm chip] [mode chip] [model chip] ... cwd.
// `permMode` is the raw permission mode ('default' | 'acceptEdits' | 'yolo' |
// 'plan'); an empty or unknown value degrades to no permission/mode chips.
// `thinking` (optional level string) appends a dim `thinking: level` to the
// model chip. Chips are separated by a dim `·`; cwd stays dim right-aligned.
const PERM_LABELS = {
  default: { zh: '需要时询问', en: 'Ask When Needed' },
  acceptEdits: { zh: '自动批准编辑', en: 'Auto Edits' },
  yolo: { zh: '全部自动允许', en: 'Bypass Permissions' },
  plan: { zh: '只读模式', en: 'Read Only' },
};
export { PERM_LABELS };

export function renderStatus({ cost = '', permMode = '', mode = '', model = '', thinking = '', cwd = '', lang = 'en' }, width, theme = null) {
  const dim = theme?.inactive ?? '';
  const reset = '\x1b[0m';
  const d = (s) => (dim ? `${dim}${s}${reset}` : s);
  const chip = (color, s) => (color ? `${color}${s}${reset}` : s);
  const parts = [];
  if (cost) parts.push(d(cost));
  if (PERM_LABELS[permMode]) parts.push(chip(theme?.warning, PERM_LABELS[permMode][lang] ?? PERM_LABELS[permMode].en));
  if (PERM_LABELS[permMode]) {
    const plan = permMode === 'plan' || mode === 'plan';
    parts.push(chip(plan ? theme?.brand : theme?.success, plan ? 'plan' : 'act'));
  }
  if (model) parts.push(thinking ? `${model} ${d(`thinking: ${thinking}`)}` : model);
  let left = parts.length ? ' ' + parts.join(d(' · ')) : '';
  const right = cwd ? d(cwd) : '';
  const room = width - visibleLen(right) - 1;
  if (visibleLen(left) > room) left = truncateAnsi(left, Math.max(0, room));
  const gap = Math.max(1, width - visibleLen(left) - visibleLen(right));
  return padLine(`${left}${' '.repeat(gap)}${right}`, width);
}

// --- transcript entries -------------------------------------------------------

// A tool card goes: running (spinner) -> done | error. Folded by default; the
// user expands with a key, and /diff-style expansion is handled by the caller.
export function createCard(kind, title) {
  return { kind, title, status: 'running', summaryLines: [], fullLines: [], expanded: false };
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// User bubble: bubble background across width-4 columns, brand-colored ›
// bar on the first row, continuations indented to the text column. Plain text
// only — no markdown restyling of the user's own words.
export function renderUserBubble(text, width, theme = null, colors = true) {
  if (!colors) return wrapText(String(text), width);
  const innerW = Math.max(10, width - 4);
  const bodyW = innerW - 2;
  const bg = theme?.userBubbleBg ?? '';
  const bar = theme?.brand ?? '';
  const reset = '\x1b[0m';
  return wrapText(String(text), bodyW).map((row, k) => {
    const pad = row + ' '.repeat(Math.max(0, bodyW - visibleLen(row)));
    return `${k === 0 ? `${bar}› ${reset}` : '  '}${bg}${pad}${reset}`;
  });
}

// Tool card three-state machine (Open Code InlineTool/BlockTool states):
// running = braille spinner, done = green ✓, error = red ✗, denied = red ✗
// with the title struck through. The status icon always occupies a fixed
// 2-column prefix (icon + space) so titles align across states.
export function renderCard(card, { width, spinFrame = 0, colors = true, theme = null } = {}) {
  const C = theme
    ? { green: theme.success, red: theme.error, cyan: theme.permission, gray: theme.inactive, reset: '\x1b[0m' }
    : { green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m' };
  const p = (c, s) => (colors ? `${c}${s}${C.reset}` : s);
  const strike = (s) => (colors ? `\x1b[9m${s}\x1b[29m` : s);
  const bodyRows = (pad) => {
    const shown = card.expanded ? card.fullLines : card.summaryLines;
    const rows = [];
    for (const l of shown.filter((x) => String(x).trim() !== '').slice(0, card.expanded ? 30 : 3)) {
      rows.push(padLine(`${pad}${p(C.gray, '│')} ${truncateAnsi(l, width - 4)}`, width));
    }
    if (!card.expanded && card.fullLines.length > 3) {
      rows.push(padLine(`${pad}${p(C.gray, '│')} ⌄ (${card.fullLines.length - 3} more lines, ctrl+o to expand)`, width));
    }
    if (card.expanded || card.fullLines.length > 3) {
      rows.push(padLine(`${pad}${p(C.gray, '· ctrl+o to expand/collapse')}`, width));
    }
    return rows;
  };
  // Tool cards carry a leading ●: it becomes the state icon (✓ done, ✗ error
  // or denied, spinner while running); the title keeps its plain shape.
  const m = /^●/.exec(card.title);
  if (m) {
    const rest = card.title.slice(1);
    if (card.status === 'running') {
      const spin = SPINNER[spinFrame % SPINNER.length];
      const body = card.summaryLines.length ? card.summaryLines[0] : '';
      return [padLine(`${p(C.cyan, spin)}${rest}${body ? ` — ${truncateAnsi(body, Math.max(10, width - visibleLen(card.title) - 8))}` : ''}`, width)];
    }
    if (card.status === 'denied') {
      const lines = [padLine(`${p(C.red, '✗')}${strike(rest)}`, width)];
      lines.push(...bodyRows('  '));
      return lines;
    }
    const col = card.status === 'error' ? C.red : C.green;
    const icon = card.status === 'error' ? '✗' : '✓';
    const lines = [padLine(`${p(col, icon)}${rest}`, width)];
    lines.push(...bodyRows('  '));
    return lines;
  }
  if (card.status === 'running') {
    const spin = SPINNER[spinFrame % SPINNER.length];
    const body = card.summaryLines.length ? card.summaryLines[0] : '';
    return [padLine(`${p(C.cyan, spin)} ${card.title}${body ? ` — ${truncateAnsi(body, Math.max(10, width - visibleLen(card.title) - 6))}` : ''}`, width)];
  }
  const denied = card.status === 'denied';
  const mark = denied ? p(C.red, '✗') : card.status === 'error' ? p(C.red, '✗') : p(C.green, '✓');
  const lines = [padLine(`${mark} ${denied ? strike(card.title) : card.title}`, width)];
  lines.push(...bodyRows('  '));
  return lines;
}

// Composer box, Open Code style: ONLY a left border (▎, brand-colored), a
// raised background, no top/bottom rules and no right edge. The first row
// carries the brand-bold `› ` prefix (continuation rows indent by 2); empty
// drafts show the placeholder dimmed. `cursor` is the caret's DISPLAY column
// in the last row and left-scrolls the row so the caret stays visible.
export function buildInputBox({ text = '', width, theme = null, placeholder = '', multiline = false, cursor = null }) {
  const w = Math.max(6, width);
  const pad = w < 44 ? 1 : 2; // OC: tighter padding on narrow terminals
  const bodyW = w - pad - 2; // border + '› ' prefix
  const brand = theme?.brand ?? '';
  const dim = theme?.inactive ?? '';
  const bg = theme?.userBubbleBg ?? '';
  const reset = '\x1b[0m';
  const bar = brand ? `${brand}▎${reset}` : '▎';
  const prompt = brand ? `${brand}\x1b[1m› ${reset}` : '› ';

  const draft = String(text);
  const isEmpty = draft === '';
  const body = isEmpty ? [placeholder] : (multiline ? draft.split('\n') : [draft.split('\n')[0]]);
  const fitTo = (line, limit) => {
    if (visibleLen(line) <= limit) return line;
    if (line.includes('\x1b[')) return truncateAnsi(line, limit);
    let out = '', cw = 0;
    for (const g of graphemes(line)) {
      const gw = charWidth(g);
      if (cw + gw > limit) break;
      out += g;
      cw += gw;
    }
    return out;
  };
  const fit = (line) => fitTo(line, bodyW);
  const rows = body.map((line, i) => {
    const isLast = i === body.length - 1;
    let shown = line;
    if (isEmpty) shown = dim ? `${dim}${line}${reset}` : line;
    else if (isLast && cursor !== null && visibleLen(shown) > bodyW) {
      shown = stripFirstChars(shown, Math.max(0, cursor - bodyW + 1));
    }
    const prefix = i === 0 ? prompt : '  ';
    const content = `${prefix}${fit(shown)}`;
    let inner = ' '.repeat(pad) + content;
    inner = fitTo(inner, w - 1); // whole clusters may overflow by one col
    const padded = inner + ' '.repeat(Math.max(0, w - 1 - visibleLen(inner)));
    return bg ? `${bar}${bg}${padded}${reset}` : `${bar}${padded}`;
  });
  return rows;
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
