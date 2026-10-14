// Thinking-chain display (P2-5): thinking blocks stay local (never sent back
// upstream); the REPL renders them as collapsible cards — a one-line summary
// with the char count after each turn, and `/thinking` expands the full text
// of the most recent turn.
export function thinkingBlocksOf(messages) {
  const out = [];
  for (const m of messages) {
    for (const b of m.content || []) {
      if (b.type === 'thinking' && b.thinking?.trim()) out.push(b);
    }
  }
  return out;
}

export function summarizeThinking(text, maxLen = 60) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

export function renderThinkingCard(block, { expanded = false, colors = true } = {}) {
  const C = { dim: '\x1b[2m', cyan: '\x1b[36m', reset: '\x1b[0m' };
  const paint = (c, s) => (colors ? `${c}${s}${C.reset}` : s);
  const text = block.thinking;
  const header = paint(C.cyan, `  ⏷ thinking · ${text.length.toLocaleString()} chars`);
  if (expanded) {
    const body = text.split('\n').map((l) => `  │ ${l}`).join('\n');
    return `${header}\n${paint(C.dim, body)}`;
  }
  return `${header} — ${paint(C.dim, summarizeThinking(text))}`;
}
