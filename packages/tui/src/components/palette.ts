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
/** Rows the palette shows before it scrolls around the selection (the task panel's idiom). */
const WINDOW = 7;

export function paletteLines(commands: readonly TuiCommand[], index: number, width: number): readonly Line[] {
  const inner = width - 4;
  // The dock clips what does not fit (session-frame `maxDock`), and a 24-command card never
  // does: without a window the marker walks below the fold on short terminals while the page
  // looks frozen — and Enter still runs the invisible selection.
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), commands.length - WINDOW));
  const shown = commands.slice(start, start + WINDOW);
  const body: CardBodyLine[] = shown.map((command, offset) => {
    const row = start + offset;
    const selected = row === index;
    // `truncate` measures; the card's own padding does the rest. Hand-rolled spaces here were
    // wrong the moment a summary was Chinese (`.length` counts characters, not cells).
    return {
      text: truncate(`${selected ? '❯' : ' '} /${command.name}  ${command.summary}`, inner),
      token: selected ? 'brand' : 'textDim',
      hit: `palette:${String(row)}`,
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
