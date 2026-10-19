/**
 * Line diff, ported from v1's `agent/src/diffcard.js` (`computeLineDiff` + `unifiedDiff`).
 *
 * Migrated, not reinvented: the LCS and the hunk grouping were already written and exercised
 * in v1, and rewriting them would only give us a second chance to get the off-by-one in
 * `@@ -a,b +c,d @@` wrong. What is NOT ported is v1's syntax tinting (`highlightCode`) — it
 * emits ANSI escape sequences into a string, which is exactly what this package's `Line`
 * model exists to avoid: colour is a token, and the renderer decides what to do with it.
 */
export interface DiffLine {
  readonly sign: ' ' | '-' | '+';
  readonly text: string;
}

export interface UnifiedLine {
  readonly kind: 'line';
  readonly sign: ' ' | '-' | '+';
  readonly text: string;
  /** The line number on the old side, or `null` for an added line. */
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface UnifiedHunk {
  readonly kind: 'hunk';
  readonly header: string;
}

export type UnifiedItem = UnifiedLine | UnifiedHunk;

export interface UnifiedDiff {
  readonly items: readonly UnifiedItem[];
  readonly added: number;
  readonly removed: number;
}

/** Above this many cells the LCS table is abandoned for a replace-everything diff. */
const MAX_LCS_CELLS = 4_000_000;

export function computeLineDiff(oldLines: readonly string[], newLines: readonly string[]): readonly DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  // Edit scenarios are small. Beyond the cap the honest answer is "everything changed" —
  // an O(n·m) table on a generated file would cost more than the diff is worth.
  if (n * m > MAX_LCS_CELLS) {
    return [...oldLines.map((line): DiffLine => ({ sign: '-', text: line })), ...newLines.map((line): DiffLine => ({ sign: '+', text: line }))];
  }

  // A flat table with an explicit index: `dp[i][j]` would need `!` everywhere under
  // `noUncheckedIndexedAccess`, and a non-null assertion in an algorithm is a promise nobody
  // checked. One allocation, one helper, no assertions.
  const stride = m + 1;
  const cells = new Uint32Array((n + 1) * stride);
  const common = (i: number, j: number): number => cells[i * stride + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      cells[i * stride + j] =
        oldLines[i] === newLines[j] ? common(i + 1, j + 1) + 1 : Math.max(common(i + 1, j), common(i, j + 1));
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ sign: ' ', text: oldLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if (common(i + 1, j) >= common(i, j + 1)) {
      ops.push({ sign: '-', text: oldLines[i] ?? '' });
      i += 1;
    } else {
      ops.push({ sign: '+', text: newLines[j] ?? '' });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ sign: '-', text: oldLines[i] ?? '' });
    i += 1;
  }
  while (j < m) {
    ops.push({ sign: '+', text: newLines[j] ?? '' });
    j += 1;
  }
  return ops;
}

/**
 * A unified diff with hunks: only the changed regions, `context` unchanged lines around each,
 * plus the counts a card's header wants. An empty diff is what an unchanged pair gives, and
 * that is a real answer ("this edit changed the bytes' casing of nothing").
 */
export function unifiedDiff(oldText: string, newText: string, options: { readonly context?: number } = {}): UnifiedDiff {
  const context = options.context ?? 2;
  const split = (text: string): readonly string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const ops = computeLineDiff(split(oldText), split(newText));

  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.sign !== ' ') changed.push(index);
  });

  const hunks: { start: number; end: number }[] = [];
  for (const index of changed) {
    const last = hunks[hunks.length - 1];
    if (last !== undefined && index - last.end <= context * 2) last.end = index;
    else hunks.push({ start: index, end: index });
  }

  const items: UnifiedItem[] = [];
  let opIndex = 0;
  let oldNo = 1;
  let newNo = 1;
  const advance = (op: DiffLine): void => {
    if (op.sign !== '+') oldNo += 1;
    if (op.sign !== '-') newNo += 1;
  };

  for (const hunk of hunks) {
    const from = Math.max(0, hunk.start - context);
    const to = Math.min(ops.length - 1, hunk.end + context);
    while (opIndex < from) {
      const op = ops[opIndex];
      if (op !== undefined) advance(op);
      opIndex += 1;
    }
    let hunkOld = 0;
    let hunkNew = 0;
    const lines: UnifiedLine[] = [];
    while (opIndex <= to && opIndex < ops.length) {
      const op = ops[opIndex];
      opIndex += 1;
      if (op === undefined) continue;
      if (op.sign === ' ') {
        lines.push({ kind: 'line', sign: ' ', text: op.text, oldNo, newNo });
        oldNo += 1;
        newNo += 1;
        hunkOld += 1;
        hunkNew += 1;
      } else if (op.sign === '-') {
        lines.push({ kind: 'line', sign: '-', text: op.text, oldNo, newNo: null });
        oldNo += 1;
        hunkOld += 1;
      } else {
        lines.push({ kind: 'line', sign: '+', text: op.text, oldNo: null, newNo });
        newNo += 1;
        hunkNew += 1;
      }
    }
    const firstOld = lines.find((line) => line.oldNo !== null)?.oldNo ?? oldNo;
    const firstNew = lines.find((line) => line.newNo !== null)?.newNo ?? newNo;
    items.push({ kind: 'hunk', header: `@@ -${String(firstOld)},${String(hunkOld)} +${String(firstNew)},${String(hunkNew)} @@` });
    items.push(...lines);
  }
  while (opIndex < ops.length) {
    const op = ops[opIndex];
    if (op !== undefined) advance(op);
    opIndex += 1;
  }

  const stats = ops.reduce(
    (totals, op) => ({
      added: totals.added + (op.sign === '+' ? 1 : 0),
      removed: totals.removed + (op.sign === '-' ? 1 : 0),
    }),
    { added: 0, removed: 0 },
  );
  return { items, added: stats.added, removed: stats.removed };
}

export interface Folded {
  readonly items: readonly UnifiedItem[];
  /** How many lines were folded away in the middle. */
  readonly collapsed: number;
}

/** Keep the head and the tail, say how many lines are missing (v1's `foldItems`).
 *
 * `maxLines` is the BUDGET, marker included: a card that folds to `maxLines + 1` lines is a
 * card whose height depends on whether it folded, which is how a layout budget gets spent
 * by the thing that was supposed to save it.
 */
export function foldItems(items: readonly UnifiedItem[], maxLines = 12): Folded {
  if (items.length <= maxLines) return { items, collapsed: 0 };
  const head = Math.ceil((maxLines - 1) / 2);
  const tail = Math.floor((maxLines - 1) / 2);
  const collapsed = items.length - head - tail;
  return {
    items: [
      ...items.slice(0, head),
      { kind: 'line', sign: ' ', text: `… ${String(collapsed)} 行折叠`, oldNo: null, newNo: null },
      ...items.slice(items.length - tail),
    ],
    collapsed,
  };
}
