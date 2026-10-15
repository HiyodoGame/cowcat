// Transcript regions: every kind of transcript content (assistant streaming
// text, tool cards, diff/approval cards, status lines, user bubbles, plain
// text) is a Region — an object with identity (id/kind) and its own state,
// producing ANSI lines through a pure `render(width)` that reuses the
// truncation/SGR-carry utilities from render.js. Each region caches its lines
// per width; mutating callers mark it dirty instead of rebuilding the whole
// transcript. Regions are the elements of TuiUI.entries, so they intentionally
// keep the duck-typed surface (`kind`, `_rendered`, `card`) the UI and its
// tests already use.
import { wrapText, truncateAnsi, padLine, renderCard, renderUserBubble } from './render.js';
import { thinkingSummary } from './footer.js';

let nextRegionId = 1;

export class Region {
  constructor(kind) {
    this.id = nextRegionId++;
    this.kind = kind;
    this._rendered = null;   // {width, lines} | null — per-width line cache
    this._expanded = false;  // reserved fold state; CardRegion delegates to the card
  }

  // Fold state interface (placeholder for later collapse/overlay work).
  get expanded() { return this._expanded; }
  set expanded(v) { this._expanded = v; }

  // Dirty mark: the next lines()/heightAt() call at any width re-renders.
  markDirty() { this._rendered = null; }

  // Cached line materialization at a width.
  lines(width) {
    const cached = this._rendered;
    if (cached && cached.width === width) return cached.lines;
    const lines = this.render(width);
    this._rendered = { width, lines };
    return lines;
  }

  // Line count at a width. Regions that can count cheaply without building
  // text rows override this so scrolled-off content costs nothing.
  heightAt(width) {
    return this.lines(width).length;
  }

  // Pure: width -> ANSI line array. Must not mutate external state.
  render(_width) { return []; }

  // Palette swap hook: regions holding pre-rendered styled state (the
  // assistant markdown renderer) rebuild it here; base regions only need the
  // dirty mark, which the caller applies first.
  onThemeChange() {}
}

// Plain print() text: wrapped to the width, no markdown restyling.
export class TextRegion extends Region {
  constructor(lines) {
    super('text');
    this.source = Array.isArray(lines) ? lines : [String(lines)];
  }

  render(width) {
    const out = [];
    for (const l of this.source) out.push(...wrapText(l, width));
    return out;
  }
}

// User turn bubble.
export class UserRegion extends Region {
  constructor(text, style) {
    super('user');
    this.text = String(text);
    this._style = style; // shared mutable {theme, colors, spinFrame}
  }

  render(width) {
    return renderUserBubble(this.text, width, this._style.theme, this._style.colors);
  }
}

// Assistant streaming markdown. Owns the incremental markdown renderer and
// the closed-rows/open-tail split; width changes replay the raw stream into a
// fresh renderer, exactly like the old _replayAssistant.
//
// Thinking slot (reserved): the provider layer does not stream reasoning
// deltas to the UI yet, but the region already knows how to fold them — feed
// thinking text via setThinking() and the materialized rows open with a
// one-line muted summary (footer.thinkingSummary) instead of the raw block.
export class AssistantRegion extends Region {
  constructor(createRenderer, width) {
    super('assistant');
    this.createRenderer = createRenderer; // (width) => markdown renderer
    this.rendererWidth = width;
    this.renderer = createRenderer(width);
    this.raw = '';
    this.closedRows = [];
    this.tailRows = [];
    this.done = false;
    this.thinkingText = null;  // reserved: accumulated reasoning deltas
    this.thinkingMs = 0;       // reserved: reasoning duration for the summary
    this._thinkingExpanded = false;
  }

  // Reserved thinking-block interface.
  get thinkingExpanded() { return this._thinkingExpanded; }
  set thinkingExpanded(v) { this._thinkingExpanded = v; this.markDirty(); }

  setThinking(text, elapsedMs = 0) {
    this.thinkingText = String(text);
    this.thinkingMs = elapsedMs;
    this.markDirty();
  }

  clearThinking() {
    this.thinkingText = null;
    this.thinkingMs = 0;
    this.markDirty();
  }

  // One streamed chunk: newly closed rows are emitted once and kept, the open
  // tail is replaced wholesale. A `supersedes` result (fast→full markdown
  // transition) replaces the closed section instead of appending.
  push(chunk) {
    this.raw += chunk;
    const rows = this.renderer.push(chunk);
    if (rows.supersedes) this.closedRows = rows.slice(0, rows.splitIndex);
    else this.closedRows.push(...rows.slice(0, rows.splitIndex));
    this.tailRows = rows.slice(rows.splitIndex);
  }

  finish() {
    if (this.done) return;
    this.push('');
    this.done = true;
  }

  _replay(width) {
    this.renderer = this.createRenderer(width);
    this.rendererWidth = width;
    const rows = this.renderer.push(this.raw);
    this.closedRows = rows.slice(0, rows.splitIndex);
    this.tailRows = rows.slice(rows.splitIndex);
  }

  onThemeChange() { this._replay(this.rendererWidth); }

  heightAt(width) {
    const cached = this._rendered;
    if (cached && cached.width === width) return cached.lines.length;
    if (this.rendererWidth !== width) this._replay(width);
    return this._thinkingRows().length + this.closedRows.length + this.tailRows.length;
  }

  render(width) {
    if (this.rendererWidth !== width) this._replay(width);
    return [...this._thinkingRows(), ...this.closedRows, ...this.tailRows].map((r) => r.text ?? r);
  }

  // Thinking block rows (reserved slot): a one-line summary while collapsed,
  // the summary plus the raw reasoning text once expanded.
  _thinkingRows() {
    if (!this.thinkingText) return [];
    const summary = thinkingSummary(this.thinkingMs / 1000);
    if (!this.thinkingExpanded) return [{ text: summary }];
    return [{ text: summary }, ...String(this.thinkingText).split('\n').map((text) => ({ text }))];
  }
}

// Tool/approval card. `card` stays a plain createCard() object so callers can
// mutate status/summaryLines/fullLines and key handlers can toggle
// card.expanded directly; fold state delegates to the card.
export class CardRegion extends Region {
  constructor(card, style) {
    super('card');
    this.card = card;
    this._style = style;
  }

  get expanded() { return this.card.expanded; }
  set expanded(v) { this.card.expanded = v; }

  render(width) {
    const { theme, colors, spinFrame } = this._style;
    return this.card.kind === 'approval'
      ? renderApprovalCard(this.card, { width, colors, theme })
      : renderCard(this.card, { width, spinFrame, colors, theme });
  }
}

// Approval card frame: permission-tinted mark/border column. Body folds to
// the quip; ctrl+o expands to the fullLines (quip + diff preview rows).
export function renderApprovalCard(card, { width, colors = true, theme = null } = {}) {
  const perm = theme?.permission ?? '\x1b[36m';
  const p = (s) => (colors ? `${perm}${s}\x1b[0m` : s);
  const lines = [padLine(`${p('✓')} ${card.title}`, width)];
  const shown = card.expanded ? card.fullLines : card.summaryLines;
  for (const l of shown.slice(0, card.expanded ? 30 : 3)) {
    lines.push(padLine(`  ${p('│')} ${truncateAnsi(l, width - 4)}`, width));
  }
  if (!card.expanded && card.fullLines.length > 3) {
    lines.push(padLine(`  ${p('│')} ··· (${card.fullLines.length} lines) ···`, width));
  }
  if (card.expanded || card.fullLines.length > 3) {
    lines.push(padLine(`  ${p('· ctrl+o to expand/collapse')}`, width));
  }
  return lines;
}

// Materialize only the regions intersecting the transcript window
// [off, off+count): returns exactly `count` entries, `undefined` where the
// transcript runs out (buildScreen pads those to blank rows). Regions fully
// before or after the window are never rendered — only heightAt() is asked.
export function materializeWindow(regions, width, off, count) {
  const out = [];
  let pos = 0;
  for (const r of regions) {
    const h = r.heightAt(width);
    if (pos + h > off && out.length < count) {
      const lines = r.lines(width);
      for (let i = Math.max(0, off - pos); i < h && out.length < count; i++) out.push(lines[i]);
    }
    pos += h;
    if (pos >= off + count) break;
  }
  while (out.length < count) out.push(undefined);
  return out;
}
