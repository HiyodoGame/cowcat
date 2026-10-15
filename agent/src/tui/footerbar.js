// Status-bar (footer) layout for the TUI, modeled on Open Code's
// promptFooterLayout + footer degradation: a left region (idle directory or
// the running spinner), a chip cluster, a droppable info area on the right
// (context usage · cost · key hints), and a right anchor (cwd). Everything is
// pure and width-budgeted — segments drop from right to left, never fake data.
import { visibleLen, truncateAnsi, padLine } from './render.js';

// ~/dir abbreviation. Only paths under the user's home collapse; a Windows
// drive path outside home (e.g. F:/WorkSpace) is returned as-is. Separators
// are normalized before comparing so both slash styles work.
export function abbreviateDir(dir, home = null) {
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const d = norm(dir);
  if (!d) return d;
  if (!home) return d;
  const h = norm(home);
  const dl = d.toLowerCase();
  const hl = h.toLowerCase();
  if (dl === hl) return '~';
  if (dl.startsWith(`${hl}/`)) return `~${d.slice(h.length)}`;
  return d;
}

// Cost formatting: `$0.00`. Anything that is not a finite number formats to
// '' — the footer omits the segment rather than inventing a figure.
export function formatCost(value) {
  if (value === '' || value == null) return ''; // unknown cost omits the segment
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  return `$${n.toFixed(2)}`;
}

// Token count formatting: 12345 -> `12.3k`.
export function formatTokenCount(n) {
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Open Code's promptFooterLayout: decide which right-side groups fit into the
// available width (never more than half the row, capped at 28 columns).
export function promptFooterLayout({ width, usage = [], shortcuts = [] }) {
  const usageStr = usage.join(' · ');
  const shortcutsStr = shortcuts.join(' · ');
  const available = Math.max(0, width - Math.min(28, Math.floor(width / 2)));
  if (usageStr && shortcutsStr && visibleLen(`${usageStr} · ${shortcutsStr}`) <= available) {
    return { usage: true, shortcuts: true };
  }
  if (usageStr && visibleLen(usageStr) <= available) return { usage: true, shortcuts: false };
  if (!usageStr && shortcutsStr && visibleLen(shortcutsStr) <= available) return { usage: false, shortcuts: true };
  return { usage: false, shortcuts: false };
}

// Assemble the single status row. `info` segments occupy the right cluster
// (joined with infoSep) just left of `right`; they drop from right to left
// until the core (left + chips) fits untruncated. If the core alone is wider
// than the room, it is truncated exactly like the legacy renderStatus.
export function footerLine({ width, left = '', chips = [], info = [], right = '', chipSep = ' · ', infoSep = '  ' }) {
  const core = [left, ...chips].filter(Boolean).join(chipSep);
  const coreStr = core ? ` ${core}` : '';
  for (let n = info.length; n >= 0; n--) {
    const infoStr = info.slice(0, n).join(infoSep);
    const cluster = [infoStr, right].filter(Boolean).join(infoSep);
    const room = Math.max(0, width - visibleLen(cluster) - 1);
    const coreFits = visibleLen(coreStr) <= room;
    if (!coreFits && n > 0) continue; // drop the next info segment and retry
    const line = coreFits ? coreStr : truncateAnsi(coreStr, room);
    const gap = Math.max(1, width - visibleLen(line) - visibleLen(cluster));
    return { line: padLine(`${line}${' '.repeat(gap)}${cluster}`, width), dropped: info.slice(n) };
  }
  // unreachable (n === 0 always fits after truncation), kept for clarity
  return { line: padLine(truncateAnsi(coreStr, width), width), dropped: info };
}
