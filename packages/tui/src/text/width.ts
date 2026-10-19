/**
 * Display width, in terminal cells — the part of alignment that is OURS (ADR-056).
 *
 * ported from v1's `agent/src/tui/wcwidth.js`, with the defect that `tools/p6-tui-probe.mjs`
 * found fixed rather than carried over:
 *
 *   v1 kept TWO range tables and binary-searched each. `RANGES_WIDE` was sorted;
 *   `RANGES_EMOJI` was not — it ran `…1f1e6-1f1ff, 1f300-1f64f, …, 1fa70-1faff, 2600-26ff,
 *   2700-27bf`, so a binary search over it could miss half its own entries. Every emoji in
 *   `2600-27BF` that was not also in the wide table measured 1 cell and shifted everything
 *   after it by one column.
 *
 * The fix here is structural rather than a re-sort: ONE table, sorted at load, so a second
 * table cannot drift out of order. The sort is asserted in `test/width.test.ts` — a table
 * that is not sorted is the failure mode, and the assertion is what keeps the merge honest.
 */

/** East Asian Wide/Fullwidth, plus the emoji ranges terminals draw double-width. */
const RAW_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2600, 0x26ff],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2700, 0x27bf],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/**
 * The one table: sorted by start AND merged so no two ranges overlap or touch.
 *
 * Both properties are load-bearing for a binary search, and v1 had neither: its second
 * table was out of order, and its two tables overlapped each other. Overlapping ranges break
 * a binary search even when the order is right — with `[0x100,0x300]` before `[0x200,0x250]`,
 * looking up `0x280` steps right past the range that contains it. Merging is what makes the
 * membership test total, and `test/width.test.ts` asserts both properties on this array.
 */
export const RANGES: readonly (readonly [number, number])[] = normalize(RAW_RANGES);

function normalize(source: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
  const sorted = [...source].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    // `+ 1` swallows adjacency as well as overlap: two touching ranges behave exactly like
    // one, and a smaller table is a smaller search.
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const COMBINING = /[\p{Mn}\p{Me}\p{Mc}]/u;
const SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Grapheme clusters: what a terminal moves the cursor by, not what UTF-16 counts. */
export function graphemes(text: string): readonly string[] {
  return [...SEGMENTER.segment(text)].map((entry) => entry.segment);
}

function inRanges(codePoint: number): boolean {
  let low = 0;
  let high = RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = RANGES[middle];
    if (range === undefined) return false;
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

/** How many cells one grapheme cluster occupies: 0 for combining marks, else 1 or 2. */
export function charWidth(cluster: string): number {
  if (cluster === '') return 0;
  const codePoint = cluster.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (COMBINING.test(String.fromCodePoint(codePoint))) return 0;
  return inRanges(codePoint) ? 2 : 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemes(text)) width += charWidth(cluster);
  return width;
}

/**
 * Cut to `maxWidth` cells, never through the middle of a cluster and never wider than asked.
 * Returns what fit and what did not, so a caller can decide about an ellipsis.
 */
export function sliceWidth(text: string, maxWidth: number): { readonly text: string; readonly rest: string } {
  const clusters = graphemes(text);
  let width = 0;
  let index = 0;
  while (index < clusters.length) {
    const cluster = clusters[index];
    if (cluster === undefined) break;
    const next = width + charWidth(cluster);
    if (next > maxWidth) break;
    width = next;
    index += 1;
  }
  return { text: clusters.slice(0, index).join(''), rest: clusters.slice(index).join('') };
}

/**
 * Fit into exactly `maxWidth` cells, with `…` where something was cut.
 *
 * The ellipsis is one cell and is part of the budget — an "overflow marker" that itself
 * overflows the border is the bug this exists to prevent.
 */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  const { text: kept } = sliceWidth(text, Math.max(0, maxWidth - 1));
  return `${kept}…`;
}

/** Pad (or truncate) to exactly `maxWidth` cells. */
export function padTo(text: string, maxWidth: number, align: 'left' | 'right' = 'left'): string {
  const fitted = truncate(text, maxWidth);
  const padding = ' '.repeat(Math.max(0, maxWidth - stringWidth(fitted)));
  return align === 'left' ? `${fitted}${padding}` : `${padding}${fitted}`;
}
