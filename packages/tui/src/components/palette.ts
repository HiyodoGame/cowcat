import type { TuiCommand } from '../app/commands.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The command palette: the table, drawn.
 *
 * It exists because a TUI with twenty keybindings has a discoverability problem, and because
 * the table it draws is the same one the `/`-commands run through (`app/commands.ts`) — so the
 * palette can never offer something the input cannot.
 *
 * The selection is a marker plus a bold line rather than reverse video: the frame snapshots
 * compare characters, and a highlight that only exists as an attribute would be invisible to
 * them (it would also be invisible in a terminal with no colour).
 */
export function paletteLines(commands: readonly TuiCommand[], index: number, width: number): readonly Line[] {
  const inner = width - 4;
  const body: CardBodyLine[] = commands.map((command, row) => {
    const selected = row === index;
    // `truncate` measures; the card's own padding does the rest. Hand-rolled spaces here were
    // wrong the moment a summary was Chinese (`.length` counts characters, not cells).
    return {
      text: truncate(`${selected ? '❯' : ' '} /${command.name}  ${command.summary}`, inner),
      token: selected ? 'brand' : 'textDim',
    };
  });

  return card({
    title: '命令',
    titleToken: 'brand',
    suffix: '↑↓ 选 · 回车跑 · Esc 关',
    body,
    width,
  });
}
