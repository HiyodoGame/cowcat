import { stringWidth, sliceWidth } from './width.js';

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
 * `sliceWidth` guarantees that) when a word is longer than the line.
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
  const lines: string[] = [];
  let rest = logical;
  while (stringWidth(rest) > width) {
    const { text: chunk, rest: remainder } = sliceWidth(rest, width);
    const space = chunk.lastIndexOf(' ');
    // A break after a third of the line keeps the ragged edge from becoming a column of
    // single words; anything earlier and a long word would be split for no gain.
    if (space > Math.floor(width / 3) && remainder !== '') {
      lines.push(chunk.slice(0, space));
      rest = rest.slice(chunk.slice(0, space).length).replace(/^ /, '');
    } else {
      lines.push(chunk);
      rest = remainder;
    }
  }
  lines.push(rest);
  return lines;
}
