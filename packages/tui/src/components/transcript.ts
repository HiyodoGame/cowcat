import type { Entry, TuiView } from '../app/view.js';
import { approvalCardLines, noticeLines } from './approval-card.js';
import { assistantMessageLines, userMessageLines } from './message.js';
import { toolCardLines } from './tool-card.js';
import { line, type Line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';

/**
 * The transcript: every entry as lines, top to bottom.
 *
 * It dispatches and nothing else — each card is its own module, and each of them is a pure
 * function of `(entry, view, width)`. That is what makes a frame snapshot cover them all: the
 * snapshot renders this function, so every card's layout is in the diff.
 *
 * The transcript is also where the two things that are NOT entries appear: the pending
 * approval (a question is the newest thing on screen by definition) and the live stream (text
 * that no event has replaced yet).
 */
export interface TranscriptOptions {
  readonly width: number;
  /** Milliseconds now, for the card that can say "you still there". */
  readonly now: number;
}

export function transcriptLines(view: TuiView, options: TranscriptOptions): readonly Line[] {
  const lines: Line[] = [];
  for (const entry of view.entries) {
    lines.push(...entryLines(entry, view, options), line('', 'text'));
  }

  if (view.streaming !== '') {
    lines.push(...wrap(view.streaming, options.width).map((row) => line(row, 'assistant')));
  }

  if (view.approval !== null) {
    if (view.streaming !== '') lines.push(line('', 'text'));
    lines.push(...approvalCardLines(view.approval, options));
  }

  return lines;
}

function entryLines(entry: Entry, view: TuiView, options: TranscriptOptions): readonly Line[] {
  switch (entry.kind) {
    case 'user':
      return userMessageLines(entry, options.width);
    case 'assistant':
      return assistantMessageLines(entry, options.width);
    case 'tool':
      return toolCardLines(entry, view, options.width);
    case 'notice':
      return noticeLines(entry.level, entry.text, options.width);
  }
}
