// Prompt history persistence + frecency scoring, stored as JSONL at
// ~/.cowcat/prompt-history.jsonl (COWCAT_HOME-aware). Two record types:
//   {"type":"history","text":...,"count":N,"last":epochMs}  one per unique prompt
//   {"type":"draft","text":...}                             single autosave slot
// The draft slot survives crashes (autosaved while typing) and is cleared on
// a clean session end. History lines are append-only; the draft is kept as
// the last line by rewriting the file (cheap: the file is small).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Recency bucket multiplier: fresh prompts dominate, old ones fade but keep
// a floor so frequently used entries still rank.
export function recencyFactor(last, now = Date.now()) {
  const age = now - last;
  if (age < 60 * 60 * 1000) return 1;
  if (age < 24 * 60 * 60 * 1000) return 0.7;
  if (age < 7 * 24 * 60 * 60 * 1000) return 0.4;
  return 0.2;
}

// Frecency score: frequency (use count) weighted by recency. Returns 0 for
// unknown items.
export function frecencyScore(item, now = Date.now()) {
  if (!item || !item.count) return 0;
  return item.count * recencyFactor(item.last ?? 0, now);
}

export class FrecencyStore {
  // file: absolute path to the JSONL store; null/undefined = in-memory only.
  constructor(file = null) {
    this.file = file;
    this.items = new Map(); // text -> {count, last}
    this.draft = null;
    if (this.file) this._load();
  }

  _load() {
    let raw;
    try { raw = readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'history' && typeof rec.text === 'string') {
          const cur = this.items.get(rec.text);
          this.items.set(rec.text, {
            count: Math.max(cur?.count ?? 0, rec.count ?? 1),
            last: Math.max(cur?.last ?? 0, rec.last ?? 0),
          });
        } else if (rec.type === 'draft' && typeof rec.text === 'string') {
          this.draft = rec.text;
        }
      } catch { /* skip malformed lines, keep loading */ }
    }
  }

  _serialize() {
    const lines = [];
    for (const [text, it] of this.items) {
      lines.push(JSON.stringify({ type: 'history', text, count: it.count, last: it.last }));
    }
    if (this.draft != null) lines.push(JSON.stringify({ type: 'draft', text: this.draft }));
    return `${lines.join('\n')}\n`;
  }

  _flush() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, this._serialize(), 'utf8');
    } catch { /* persistence is best-effort, never blocks the UI */ }
  }

  // Record a submitted prompt.
  add(text, now = Date.now()) {
    text = String(text);
    if (!text.trim()) return;
    const cur = this.items.get(text);
    this.items.set(text, { count: (cur?.count ?? 0) + 1, last: now });
    this._flush();
  }

  item(text) { return this.items.get(text) ?? null; }

  score(text, now = Date.now()) { return frecencyScore(this.items.get(text), now); }

  // Most-recently-used texts first (for ↑ history browsing).
  recent(limit = 100) {
    return [...this.items.entries()]
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, limit)
      .map(([text]) => text);
  }

  // Autosave slot for the in-progress draft (call with null to drop it).
  saveDraft(text) {
    const next = text == null ? null : String(text);
    if (next === this.draft) return;
    this.draft = next && next.length ? next : null;
    this._flush();
  }

  // Clean session end: the draft must not linger.
  clearDraft() { this.saveDraft(null); }
}
