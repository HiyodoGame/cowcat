// Autocomplete trigger detection + candidate ranking for the composer popup
// (modeled on Open Code's prompt autocomplete): a trigger is '@' or '/' at
// the start of the line or right after whitespace, with a whitespace-free
// query; ranking combines prefix-match doubling with a frecency bonus, capped.

// Detect the active trigger at the end of the text. Returns
// { kind: 'slash' | 'mention', start, query } or null. `start` is the offset
// of the trigger character itself (query runs to the end of the text) so
// callers can replace the whole span on accept.
export function triggerOf(text) {
  const m = /(^|\s)([@/])(\S*)$/.exec(String(text));
  if (!m) return null;
  return { kind: m[2] === '/' ? 'slash' : 'mention', start: m.index + (m[1] ? 1 : 0), query: m[3] };
}

// Rank candidates against a query. items: [{ name, desc? }] (slash) or
// strings (mentions, already filtered by the provider). Scoring: exact prefix
// doubles the base, substring match is the base, and a normalized frecency
// bonus (0..1) breaks ties toward recently/frequently used entries.
// Non-matching items are dropped; result is capped at `limit` (default 10).
export function rankCandidates(query, items, frecency = null, { limit = 10, now = Date.now() } = {}) {
  const q = String(query ?? '').toLowerCase();
  const scored = [];
  for (const raw of items) {
    const item = typeof raw === 'string' ? { name: raw } : raw;
    const name = item.name;
    const lower = name.toLowerCase();
    let base = 0;
    if (lower.startsWith(q)) base = 2;
    else if (q && lower.includes(q)) base = 1;
    else if (!q) base = 1; // empty query: everything matches at base weight
    if (!base) continue;
    let bonus = 0;
    if (frecency) {
      const s = typeof frecency.score === 'function' ? frecency.score(name, now) : 0;
      bonus = s / (s + 1); // squash to 0..1
    }
    scored.push({ item, score: base + bonus });
  }
  scored.sort((a, b) => b.score - a.score); // stable: ties keep provider order
  return scored.slice(0, limit).map((s) => s.item);
}
