import type { TokenName } from '../theme/tokens.js';
import { line, type Line } from './line.js';
import { padTo, stringWidth, truncate } from '../text/width.js';

/**
 * A card, drawn as characters.
 *
 * The brand guide's layout is boxes (§4.1: a task card per action, a terminal-output card,
 * an approval card), and the cheapest honest way to draw one in a terminal is to draw it:
 * `╭─ title ─────╮` is text, so it goes through the same `Line[]` pipeline as everything
 * else, gets the same frame snapshot, and needs no nesting of renderables (which is what
 * makes a forty-card transcript cheap to redraw).
 *
 * Every string here is measured with OUR width table: a box drawn by a library that
 * disagrees about how wide `把` is produces a right edge that does not line up.
 */
export interface CardBodyLine {
  readonly text: string;
  readonly token: TokenName;
  /** A click id for this row; the loop decides what it means. */
  readonly hit?: string;
}

export interface CardSpec {
  readonly title: string;
  readonly titleToken: TokenName;
  /** Right-aligned in the title bar: `+12 -4`, `[折叠]`. */
  readonly suffix?: string;
  readonly body?: readonly CardBodyLine[];
  /** The columns available, the border included. */
  readonly width: number;
  readonly borderToken?: TokenName;
}

const CORNER = { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│' } as const;

export function card(spec: CardSpec): readonly Line[] {
  const width = Math.max(8, spec.width);
  const border = spec.borderToken ?? 'border';
  const suffix = spec.suffix === undefined || spec.suffix === '' ? '' : ` ${spec.suffix}`;
  const suffixWidth = stringWidth(suffix);

  // The title row is `╭─ ` + title + suffix + fill + `╮`, and it has to add up to exactly
  // `width`: one cell of corner on each side and two for `─ `. The suffix carries its own
  // leading space, so it is its own separator — counting one twice is how this row came out
  // one cell short (measured by the card-width assertion in test/cards.test.ts).
  const room = Math.max(0, width - 4 - suffixWidth);
  const title = truncate(spec.title, room);
  const fill = Math.max(0, width - 4 - stringWidth(title) - suffixWidth);
  const lines: Line[] = [
    line(`${CORNER.topLeft}─ ${title}${suffix}${CORNER.horizontal.repeat(fill)}${CORNER.topRight}`, border),
  ];

  // The body rows are `│ ` + content + ` │`: four cells of frame, so `width - 4` of room.
  const inner = width - 4;
  for (const body of spec.body ?? []) {
    lines.push(line(`${CORNER.vertical} ${padTo(body.text, inner)} ${CORNER.vertical}`, body.token, false, body.hit));
  }

  lines.push(line(`${CORNER.bottomLeft}${CORNER.horizontal.repeat(Math.max(0, width - 2))}${CORNER.bottomRight}`, border));
  return lines;
}
