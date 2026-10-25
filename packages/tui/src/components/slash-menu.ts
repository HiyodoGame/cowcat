import type { TuiCommand } from '../app/commands.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The `/` menu, rendered in the dock above the composer (ADR-102).
 *
 * This replaced a placeholder string: a hint you cannot select is not a menu. The list keeps
 * Enter's meaning explicit — while it is open Enter runs the highlighted command; once there
 * is a space in the input the list disappears and Enter sends the prompt.
 */
/** Rows the menu shows before it scrolls around the selection (the task panel's idiom). */
const WINDOW = 7;

export function slashMenuLines(matches: readonly TuiCommand[], index: number, width: number): readonly Line[] {
  if (matches.length === 0) return [];
  const selected = index % matches.length;
  const inner = Math.max(8, width - 6);
  // The selection wraps the whole table (view.ts `moveSlash`), so the rows shown must follow
  // it: with a fixed top-7 slice, arrowing past the fold moved a marker nobody could see.
  const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), matches.length - WINDOW));
  const body: CardBodyLine[] = matches.slice(start, start + WINDOW).map((command, offset) => {
    const row = start + offset;
    return {
      text: truncate(`${row === selected ? '▸' : ' '} /${command.name}  ${command.summary}`, inner),
      token: row === selected ? 'act' : 'textDim',
      hit: `slash:${String(row)}`,
    };
  });
  return card({
    title: '命令',
    titleToken: 'plan',
    suffix: '↑↓ 选择 · Tab 补全 · 回车执行',
    body,
    width,
  });
}
