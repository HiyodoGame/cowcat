import { charWidth, graphemes, stringWidth } from './width.js';

/**
 * Wrapping, because a card's border has to survive the text inside it.
 *
 * The renderer wraps text on its own, but only inside a text renderable of the FULL width —
 * a card is a box drawn character by character, so its interior has to be wrapped here or
 * the border lands in the middle of the line. That is the same reason the width table is
 * ours and not opentui's (ADR-056): the model's output and the tools' output are content we
 * lay out, not text we hand over.
 *
 * Breaks at spaces when one is near, and mid-cluster (never mid-cluster *within* a grapheme —
 * the scan below guarantees that) when a word is longer than the line.
 *
 * One segmentation per logical line, walked by a cluster cursor; every chunk is a slice of
 * the original string. An earlier version re-measured and re-segmented everything still
 * unwrapped per output row, which made wrapping quadratic in the text's length — the
 * dominant cost of every redraw, and the reason a long streamed answer got slower the longer
 * it ran (measured: 172 ms to wrap 10k cells at width 100; ~1 ms after this).
 */
export function wrap(text: string, width: number): readonly string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const logical of text.split('\n')) {
    lines.push(...wrapOne(logical, width));
  }
  return lines;
}

function wrapOne(logical: string, width: number): readonly string[] {
  if (stringWidth(logical) <= width) return [logical];
  const clusters = graphemes(logical);
  // `starts[k]` is the UTF-16 offset of cluster k, so chunks stay slices of the original
  // string instead of joins over cluster arrays.
  const starts: number[] = [0];
  let offset = 0;
  for (const cluster of clusters) {
    offset += cluster.length;
    starts.push(offset);
  }

  const lines: string[] = [];
  let k = 0;
  while (k < clusters.length) {
    let used = 0;
    let end = k;
    while (end < clusters.length) {
      const cluster = clusters[end];
      if (cluster === undefined) break;
      const next = used + charWidth(cluster);
      if (next > width) break;
      used = next;
      end += 1;
    }
    if (end === k) {
      // Nothing fits: a two-cell grapheme in a one-cell line. Emit it alone — the previous
      // slice-based loop could spin forever here.
      const cluster = clusters[k];
      if (cluster !== undefined) lines.push(cluster);
      k += 1;
      continue;
    }
    const chunk = logical.slice(starts[k] ?? 0, starts[end] ?? logical.length);
    if (end < clusters.length) {
      const space = chunk.lastIndexOf(' ');
      if (space > Math.floor(width / 3)) {
        const at = (starts[k] ?? 0) + space;
        let m = k;
        while ((starts[m] ?? 0) < at) m += 1;
        if (starts[m] === at && clusters[m] === ' ') {
          // A clean space cluster: drop it and continue from the next one. This cursor jump
          // is what `rest.slice(…).replace(/^ /, '')` used to do, without re-slicing.
          lines.push(chunk.slice(0, space));
          k = m + 1;
          continue;
        }
        // The break lands inside a cluster (a space carrying combining marks). Hand the
        // remainder to a fresh pass, which re-segments it exactly as re-slicing did.
        lines.push(chunk.slice(0, space));
        lines.push(...wrapOne(logical.slice(at).replace(/^ /, ''), width));
        return lines;
      }
    }
    lines.push(chunk);
    k = end;
  }
  return lines;
}

export function wrapPath(value: string, width: number): readonly string[] {
  if (width <= 0) return [];
  if (stringWidth(value) <= width) return [value];
  const segments = value.match(/[^\\/]+[\\/]?|[\\/]+/g) ?? [value];
  const lines: string[] = [];
  let current = '';
  for (const segment of segments) {
    if (stringWidth(segment) > width) {
      if (current !== '') lines.push(current);
      lines.push(...wrap(segment, width));
      current = '';
    } else if (current === '') {
      current = segment;
    } else if (stringWidth(current + segment) <= width) {
      current += segment;
    } else {
      lines.push(current);
      current = segment;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
