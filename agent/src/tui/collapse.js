// Collapse dual-budget algorithm for tool output, ported from Open Code's
// util/collapse-tool-output.ts: a line budget AND a character budget, both
// applied from the TOP so the tail (the most recent output) always survives.
// Overflow is marked with a single `(N earlier lines)` row.

// Shipped defaults (Open Code constants): 5 lines / 1000 chars of output.
export const COLLAPSE_LIMITS = {
  lines: 5,
  chars: 1000,
  // a shell command inside a card body gets at most 2 rows
  commandLines: 2,
};

export function collapseToolOutput(content, { maxLines = COLLAPSE_LIMITS.lines, maxChars = COLLAPSE_LIMITS.chars } = {}) {
  const all = String(content ?? '').split('\n');
  // line budget: keep the tail
  let tail = all.length > maxLines ? all.slice(-maxLines) : [...all];
  // character budget: drop whole rows from the top first, then hard-cut the
  // head row — dropping rows beats slicing mid-row so ANSI/tool framing never
  // gets torn
  const joined = (ls) => ls.reduce((n, l, i) => n + (i ? 1 : 0) + l.length, 0);
  let omittedChars = 0;
  while (tail.length > 1 && joined(tail) > maxChars) {
    omittedChars += tail[0].length + 1;
    tail.shift();
  }
  if (tail.length && joined(tail) > maxChars) {
    const over = joined(tail) - maxChars;
    tail[0] = `…${tail[0].slice(over + 1)}`;
    omittedChars += over;
  }
  const omittedLines = all.length - tail.length;
  const collapsed = omittedLines > 0 || omittedChars > 0;
  const lines = omittedLines > 0 ? [`(${omittedLines} earlier lines)`, ...tail] : tail;
  return { lines, omittedLines, omittedChars, collapsed };
}

// Shell commands inside cards: at most 2 rows.
export function collapseCommand(command) {
  return collapseToolOutput(command, { maxLines: COLLAPSE_LIMITS.commandLines, maxChars: COLLAPSE_LIMITS.chars });
}
