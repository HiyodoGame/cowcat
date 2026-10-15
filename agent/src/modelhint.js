// Startup model-ref hint: when the configured "provider/model" ref is not in
// the known catalog, suggest the closest looking available refs. Pure
// functions so bin/cowcat.mjs keeps the wiring thin; the heavy validation in
// config.js#resolveModelConfig skips catalog checks for custom endpoints and
// empty catalogs, which is exactly where these hints matter.
import { configuredProviders } from './config.js';

// Case-insensitive edit distance (DP, O(min-length) memory).
function editDistance(a, b) {
  if (a === b) return 0;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  let prev = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let j = 1; j <= t.length; j++) {
    const cur = [j];
    for (let i = 1; i <= s.length; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[s.length];
}

// 0..1 similarity: 1 minus normalized edit distance, with a bonus when one
// string contains the other (model ids share long chunks like
// "claude-sonnet-5" that raw edit distance under-ranks).
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  let score = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  if (a.includes(b) || b.includes(a)) score += 0.5;
  return score;
}

// Up to `limit` catalog refs closest to `ref` (exact match -> []). Scores on
// the full "provider/model" ref first, then on the bare model id, so a ref
// with the wrong provider prefix still surfaces same-model candidates.
export function nearestRefs(ref, refs, limit = 5) {
  const needle = String(ref || '').toLowerCase();
  if (refs.some((r) => typeof r === 'string' && r.toLowerCase() === needle)) return [];
  const bare = needle.slice(needle.indexOf('/') + 1);
  const scored = refs
    .filter((r) => typeof r === 'string' && r.length)
    .map((r, index) => {
      const cand = r.toLowerCase();
      const candBare = cand.slice(cand.indexOf('/') + 1);
      const score = Math.max(similarity(needle, cand), similarity(bare, candBare) - 0.01);
      return { r, score, index };
    })
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, limit).map((s) => s.r);
}

// Every known "provider/model" ref (presets + user-defined providers), for
// validating the configured ref at startup.
export function catalogRefs(cfg = {}) {
  const refs = [];
  for (const p of configuredProviders(cfg)) {
    for (const [mid, m] of Object.entries(p.models || {})) {
      if (!m || m.disabled) continue;
      refs.push(`${p.id}/${mid}`);
    }
  }
  return refs;
}

// Warning copy (zh/en) for an unknown configured ref. Non-fatal by contract.
export function formatModelHint(ref, refs, { lang = 'zh', limit = 5 } = {}) {
  const near = nearestRefs(ref, refs, limit);
  const list = near.join(', ');
  if (lang === 'zh') {
    return {
      title: `模型 ${ref} 不在已知目录中`,
      body: `相近的可用模型：${list}。用 /model 切换，或检查 COWCAT_MODEL / config.json。`,
      line: `⚠ 模型 ${ref} 不在已知目录中（自定义 endpoint 不校验目录）。相近的可用模型：${list}。用 /model 切换，或检查 COWCAT_MODEL。`,
    };
  }
  return {
    title: `Model ${ref} is not in the known catalog`,
    body: `Closest available refs: ${list}. Switch with /model, or check COWCAT_MODEL / config.json.`,
    line: `⚠ Model ${ref} is not in the known catalog (custom endpoints skip catalog validation). Closest available refs: ${list}. Switch with /model, or check COWCAT_MODEL.`,
  };
}
