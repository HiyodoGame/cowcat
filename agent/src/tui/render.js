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

export function renderStatus({ cost = '', version = '', cwd = '', mode = '', hint = '' }, width, theme = null) {
  const left = ` ${cost}`;
  const dim = theme?.inactive ?? '';
  const mid = dim ? `${dim} cowcat/${version} ${mode}\x1b[0m` : ` cowcat/${version} ${mode}`;
  const hintPart = hint ? (dim ? `${dim} ${hint}\x1b[0m` : ` ${hint}`) : '';
  const right = cwd;
  const gap1 = Math.max(1, width - visibleLen(left) - visibleLen(mid) - visibleLen(hintPart) - visibleLen(right) - 3);
  const gap2 = Math.max(1, width - visibleLen(left) - gap1 - visibleLen(mid) - visibleLen(hintPart) - visibleLen(right));
  return padLine(`${left}${' '.repeat(gap1)}${mid}${hintPart}${' '.repeat(gap2)}${right}`, width);
}

// --- transcript entries -------------------------------------------------------

// A tool card goes: running (spinner) -> done | error. Folded by default; the
// user expands with a key, and /diff-style expansion is handled by the caller.
export function createCard(kind, title) {
  return { kind, title, status: 'running', summaryLines: [], fullLines: [], expanded: false };
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// User bubble: bubble background across width-4 columns, subtle › prefix on the
// first row, continuations indented to the text column.
export function renderUserBubble(text, width, theme = null, colors = true) {
  if (!colors) return wrapText(String(text), width);
  const innerW = Math.max(10, width - 4);
  const bodyW = innerW - 2;
  const bg = theme?.userBubbleBg ?? '';
  const subtle = theme?.inactive ?? '';
  const reset = '\x1b[0m';
  return wrapText(String(text), bodyW).map((row, k) => {
    const pad = row + ' '.repeat(Math.max(0, bodyW - visibleLen(row)));
    return `${k === 0 ? `${subtle}› ${reset}` : '  '}${bg}${pad}${reset}`;
  });
}

export function renderCard(card, { width, spinFrame = 0, colors = true, theme = null } = {}) {
  const C = theme
    ? { green: theme.success, red: theme.error, cyan: theme.permission, gray: theme.inactive, reset: '\x1b[0m' }
    : { green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m', reset: '\x1b[0m' };
  const p = (c, s) => (colors ? `${c}${s}${C.reset}` : s);
  // Tool cards carry a leading ⏺: it becomes the state-colored prefix column
  // (minWidth 2), tinted dim while running, green on success, red on error.
  const m = /^⏺/.exec(card.title);
  if (m) {
    const col = card.status === 'running' ? C.gray : card.status === 'error' ? C.red : C.green;
    const prefix = p(col, '⏺') + ' '.repeat(Math.max(0, 2 - visibleLen('⏺')));
    const rest = card.title.slice(1);
    if (card.status === 'running') {
      const spin = SPINNER[spinFrame % SPINNER.length];
      const body = card.summaryLines.length ? card.summaryLines[0] : '';
      return [padLine(`${prefix}${p(C.cyan, spin)} ${rest}${body ? ` — ${truncateAnsi(body, Math.max(10, width - visibleLen(card.title) - 8))}` : ''}`, width)];
    }
    const lines = [padLine(`${prefix}${rest}`, width)];
    const shown = card.expanded ? card.fullLines : card.summaryLines;
    for (const l of shown.slice(0, card.expanded ? 30 : 3)) {
      lines.push(padLine(`  ${p(C.gray, '│')} ${truncateAnsi(l, width - 4)}`, width));
    }
    if (!card.expanded && card.fullLines.length > 3) {
      lines.push(padLine(`  ${p(C.gray, '│')} ··· (${card.fullLines.length} lines) ···`, width));
    }
    if (card.expanded || card.fullLines.length > 3) {
      lines.push(padLine(`  ${p(C.gray, '· ctrl+o to expand/collapse')}`, width));
    }
    return lines;
  }
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

// Rounded input box: permission-tinted ╭─╮│╯─╰ frame around the draft text.
// Empty drafts show the placeholder dimmed; multiline keeps every text line
// plus one spare editing row; `cursor` is the column in the last line and
// scrolls the line horizontally so the cursor stays visible.
export function buildInputBox({ text = '', width, theme = null, placeholder = '', multiline = false, cursor = null }) {
  const w = Math.max(6, width);
  const inner = w - 2;
  const bodyW = inner - 2;
  const border = theme?.permission ?? '';
  const dim = theme?.inactive ?? '';
  const reset = '\x1b[0m';
  const frame = (s) => (border ? `${border}${s}${reset}` : s);
  const hline = '─'.repeat(inner);

  const draft = String(text);
  const isEmpty = draft === '';
  let body = isEmpty ? [placeholder] : (multiline ? draft.split('\n') : [draft.split('\n')[0]]);
  if (multiline && !isEmpty) body = [...body, ''];
  const fit = (line) => {
    if (visibleLen(line) <= bodyW) return line;
    if (line.includes('\x1b[')) return truncateAnsi(line, bodyW);
    let out = '', w = 0;
    for (const g of graphemes(line)) {
      const gw = charWidth(g);
      if (w + gw > bodyW) break;
      out += g;
      w += gw;
    }
    return out;
  };
  const rows = body.map((line, i) => {
    const isLast = i === body.length - 1;
    let shown = line;
    if (isEmpty) shown = dim ? `${dim}${line}${reset}` : line;
    else if (isLast && cursor !== null && visibleLen(shown) > bodyW) {
      shown = stripFirstChars(shown, Math.max(0, cursor - bodyW + 1));
    }
    return `${frame('│')} ${padLine(fit(shown), bodyW)} ${frame('│')}`;
  });
  return [frame(`╭${hline}╮`), ...rows, frame(`╰${hline}╯`)];
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
