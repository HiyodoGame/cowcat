// DialogSelect: the fzf-style picker primitive behind the command palette,
// session list, theme picker, and help panel. Pure model + row renderers —
// the UI frame paints the rows and feeds normalized chords into handleKey.
import { visibleLen, padLine, truncateAnsi } from './render.js';

// Subsequence fuzzy match. Weight: title matches count double (per the OC
// scorer), contiguous runs and prefix starts score bonuses. Returns a score
// (higher is better) or -1 when the query is not a subsequence.
export function fuzzyScore(query, title, group = '') {
  const q = String(query ?? '').toLowerCase();
  if (!q) return 0; // empty query: everything matches, stable order
  const t = String(title ?? '').toLowerCase();
  const g = String(group ?? '').toLowerCase();
  let score = 0;
  let ti = 0;
  let lastHit = -2; // last matched title index (for contiguity)
  let firstHit = -1;
  for (const ch of q) {
    const hit = t.indexOf(ch, ti);
    if (hit === -1) return -1;
    score += 2; // title weight ×2
    if (hit === lastHit + 1) score += 1; // contiguous run bonus
    if (firstHit === -1) {
      firstHit = hit;
      if (hit === 0) score += 3; // prefix bonus
    }
    lastHit = hit;
    ti = hit + 1;
  }
  // group subsequence: light bonus so grouped sections surface their header
  let gi = 0;
  for (const ch of q) {
    const hit = g.indexOf(ch, gi);
    if (hit === -1) break;
    score += 1;
    gi = hit + 1;
  }
  return score;
}

export class DialogSelect {
  // items: [{ id?, title, description?, group? }]
  // actions: [{ id, label }] — bottom bar; Tab cycles, enter runs onAction.
  constructor({ items = [], actions = [], pageSize = 10, onPick = null, onAction = null, onChange = null } = {}) {
    this.items = items;
    this.actions = actions;
    this.pageSize = pageSize;
    this.onPick = onPick;
    this.onAction = onAction;
    this.onChange = onChange;
    this.query = '';
    this.sel = 0;
    this.actionSel = -1; // -1: focus on the list; >= 0: focus on an action pill
    this._rank();
  }

  _rank() {
    const scored = this.items
      .map((item, index) => ({ item, index, score: fuzzyScore(this.query, item.title, item.group ?? '') }))
      .filter((s) => s.score >= 0);
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index)); // stable
    this.filtered = scored.map((s) => s.item);
    if (this.sel >= this.filtered.length) this.sel = Math.max(0, this.filtered.length - 1);
  }

  get selected() { return this.filtered[this.sel] ?? null; }

  setQuery(q) {
    this.query = String(q);
    this.sel = 0;
    this._rank();
    this.onChange?.(this.selected);
  }

  move(delta) {
    const n = this.filtered.length;
    if (!n) return;
    this.sel = (this.sel + delta % n + n) % n; // loops
    this.onChange?.(this.selected);
  }

  page(delta) { this.move(delta >= 0 ? this.pageSize : -this.pageSize); }

  // Tab cycles: list focus (-1) -> action 0 -> ... -> last action -> list.
  cycleAction(delta) {
    if (!this.actions.length) return;
    const n = this.actions.length + 1;
    const raw = (this.actionSel + 1 + delta + n) % n;
    this.actionSel = raw - 1;
  }

  confirm() {
    if (this.actionSel >= 0 && this.actions[this.actionSel]) {
      const action = this.actions[this.actionSel];
      if (this.onAction) this.onAction(action, this.selected);
      return { type: 'action', action, item: this.selected };
    }
    const item = this.selected;
    if (item && this.onPick) this.onPick(item);
    return item ? { type: 'pick', item } : { type: 'noop' };
  }

  // Normalized chords. Returns true when the key was consumed.
  handleKey(chord) {
    switch (chord) {
      case 'up': case 'ctrl+p': this.actionSel >= 0 ? this.cycleAction(-1) : this.move(-1); return true;
      case 'down': case 'ctrl+n': this.actionSel >= 0 ? this.cycleAction(1) : this.move(1); return true;
      case 'pageup': this.page(-1); return true;
      case 'pagedown': this.page(1); return true;
      case 'tab': this.cycleAction(1); return true;
      case 'shift+tab': this.cycleAction(-1); return true;
      case 'enter': this.confirm(); return true;
      case 'backspace': this.setQuery(this.query.slice(0, -1)); return true;
      case 'ctrl+u': this.setQuery(''); return true;
      default:
        if (chord.length === 1 && chord >= ' ') { this.setQuery(this.query + chord); return true; }
        return false;
    }
  }

  // --- rendering ------------------------------------------------------------

  // Visible window: the selection stays inside [start, start+pageSize).
  window() {
    const n = this.filtered.length;
    const start = Math.min(Math.max(0, this.sel - (this.pageSize - 1)), Math.max(0, n - this.pageSize));
    return { start, rows: this.filtered.slice(start, start + this.pageSize) };
  }

  // Content lines (search box + grouped rows), padded/truncated to boxW.
  rows(boxW, { colors = true, theme = null } = {}) {
    const dim = (s) => (colors && theme?.inactive ? `${theme.inactive}${s}\x1b[0m` : s);
    const brand = (s) => (colors && theme?.brand ? `${theme.brand}${s}\x1b[0m` : s);
    const lines = [];
    lines.push(` ${dim('›')} ${this.query}${' '}`);
    const { start, rows } = this.window();
    let lastGroup = null;
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        lines.push(dim(`  ${item.group}`));
      }
      const sel = start + i === this.sel;
      const arrow = sel ? brand('→') : ' ';
      const title = sel ? brand(item.title) : item.title;
      const desc = item.description ? dim(` — ${truncateAnsi(item.description, Math.max(8, boxW - visibleLen(item.title) - 10))}`) : '';
      lines.push(truncateAnsi(`  ${arrow} ${title}${desc}`, boxW));
    }
    if (!rows.length) lines.push(dim('  (no matches)'));
    return lines;
  }

  // Bottom action bar: ` [label]  [label] ` with the focused action inverted.
  actionBar(boxW, { colors = true } = {}) {
    if (!this.actions.length) return [];
    const parts = this.actions.map((a, i) => {
      const label = ` ${a.label} `;
      if (i === this.actionSel && colors) return `\x1b[7m${label}\x1b[0m`;
      return label;
    });
    return [truncateAnsi(`  ${parts.join('  ')}`, boxW)];
  }
}
