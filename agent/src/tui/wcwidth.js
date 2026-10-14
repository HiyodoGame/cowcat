// Grapheme-aware width measurement: baked EAW W/F + emoji range tables with
// binary search, Intl.Segmenter for cluster splitting. Input must already be
// ANSI-free — the caller strips escape sequences.

export const RANGES_WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

export const RANGES_EMOJI = [
  [0x1f1e6, 0x1f1ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x2600, 0x26ff],
  [0x2700, 0x27bf],
];

const COMBINING_RE = /[\p{Mn}\p{Me}\p{Mc}]/u;

function inRanges(ranges, cp) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function charWidth(ch) {
  if (!ch) return 0;
  const str = String(ch);
  const cp = str.codePointAt(0);
  if (COMBINING_RE.test(String.fromCodePoint(cp))) return 0;
  return inRanges(RANGES_WIDE, cp) || inRanges(RANGES_EMOJI, cp) ? 2 : 1;
}

const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;

export function graphemes(s) {
  const str = String(s);
  if (!SEGMENTER) return Array.from(str);
  const out = [];
  for (const { segment } of SEGMENTER.segment(str)) out.push(segment);
  return out;
}

export function stringWidth(s) {
  let w = 0;
  for (const g of graphemes(String(s))) w += charWidth(g);
  return w;
}

export function sliceWidth(s, maxWidth) {
  let w = 0;
  let i = 0;
  const gs = graphemes(String(s));
  while (i < gs.length && w < maxWidth) {
    w += charWidth(gs[i]);
    i++;
  }
  return { text: gs.slice(0, i).join(''), rest: gs.slice(i).join('') };
}
