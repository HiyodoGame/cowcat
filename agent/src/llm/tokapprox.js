// Lightweight local token estimator (no dependencies). Not a real BPE — a
// calibrated heuristic that stays within ~±20% for typical English prose,
// Chinese text, and source code, good enough for compact thresholds and
// doctor fallbacks where no count_tokens endpoint exists.

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;
const WORD_RE = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]|\s+/g;

export function estimateTokensLocal(text) {
  const s = String(text ?? '');
  let tokens = 0;
  const parts = s.match(WORD_RE) || [];
  for (const p of parts) {
    if (/^\s+$/.test(p)) {
      tokens += Math.floor(p.length / 8); // spaces mostly merge into the next word
    } else if (CJK_RE.test(p)) {
      // CJK: roughly one token per character (punctuation included)
      tokens += p.length;
    } else if (/^[A-Za-z0-9_]+$/.test(p)) {
      // words: common short words are 1 token; longer words split every ~5 chars
      tokens += 1 + Math.ceil(Math.max(0, p.length - 6) / 5);
    } else {
      // punctuation / symbol runs
      tokens += Math.max(1, Math.ceil(p.length / 2));
    }
  }
  return Math.max(1, Math.round(tokens));
}
