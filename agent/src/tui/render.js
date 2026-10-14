// Pure TUI rendering core: layout math, ANSI-aware truncation/wrapping, header
// and status bar builders, and the tool-card state machine. No side effects —
// everything here is unit-testable without a terminal.

export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLen(s) {
  return String(s).replace(ANSI_RE, '').length;
}

// Width-aware truncate that preserves ANSI sequences (drops whole sequences,
// never splits one).
export function truncateAnsi(line, width) {
  if (visibleLen(line) <= width) return line;
  let out = '';
  let vis = 0;
  const tokens = String(line).match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/g) || [];
  for (const tok of tokens) {
    if (tok.startsWith('\x1b')) { out += tok; continue; }
    if (vis >= width) break;
    out += tok;
    vis++;
  }
  return out + '\x1b[0m';
}

export function padLine(line, width) {
  const len = visibleLen(line);
  return len >= width ? truncateAnsi(line, width) : line + ' '.repeat(width - len);
}

// Greedy word-wrap honoring existing newlines; ANSI-safe by truncating chunks.
export function wrapText(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (visibleLen(line) > width) {
      // find the last break at/before width, else hard-cut
      let cut = -1;
      const plain = line.replace(ANSI_RE, '');
      for (let i = Math.min(width, plain.length); i > 0; i--) {
        if (plain[i] === ' ') { cut = i; break; }
      }
      const at = cut > 0 ? cut : width;
      out.push(truncateAnsi(line, at));
      line = stripFirstChars(line, cut > 0 ? cut + 1 : at);
    }
    out.push(line);
  }
  return out;
}

// Remove the first n visible characters from an ANSI-bearing line.
export function stripFirstChars(line, n) {
  let out = '';
  let removed = 0;
  const tokens = String(line).match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/g) || [];
  let pendingAnsi = '';
  for (const tok of tokens) {
    if (tok.startsWith('\x1b')) { pendingAnsi += tok; continue; }
    if (removed < n) { removed++; continue; }
    out += pendingAnsi + tok;
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
