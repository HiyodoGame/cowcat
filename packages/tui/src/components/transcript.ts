import type { Entry, TuiView } from '../app/view.js';
import { revealedReasoning } from '../app/view.js';
import { noticeLines } from './approval-card.js';
import { assistantMessageLines, userMessageLines } from './message.js';
import { callSummary, runningToolLines, toolCardLines } from './tool-card.js';
import { line, type Line } from '../ui/line.js';
import type { ImageSlot } from '../ui/screen.js';
import { wrap } from '../text/wrap.js';

/**
 * The transcript: every entry as lines, top to bottom — plus the images, which are not lines.
 *
 * It dispatches and nothing else — each card is its own module, and each of them is a pure
 * function of `(entry, view, width)`. That is what makes a frame snapshot cover them all: the
 * snapshot renders this function, so every card's layout is in the diff.
 *
 * The transcript is also where the two things that are NOT entries appear: the pending
 * approval (a question is the newest thing on screen by definition) and the live stream (text
 * that no event has replaced yet).
 *
 * Images are carried alongside, with their rows shifted by however many lines came before
 * them — the one piece of bookkeeping the "everything is a line" model cannot do on its own.
 */
export interface TranscriptOptions {
  readonly width: number;
  /** Milliseconds now, for the card that can say "you still there". */
  readonly now: number;
}

export interface TranscriptLines {
  readonly lines: readonly Line[];
  readonly images: readonly ImageSlot[];
}

/** Four frames is enough for a 120ms cycle to read as motion, not as a flashing glyph. */
const THINKING = ['✻', '✳', '✢', '✶'] as const;

export function transcriptLines(view: TuiView, options: TranscriptOptions): TranscriptLines {
  const lines: Line[] = [];
  const images: ImageSlot[] = [];

  const push = (part: TranscriptLines): void => {
    const offset = lines.length;
    lines.push(...part.lines);
    for (const image of part.images) images.push({ ...image, row: image.row + offset });
  };

  for (const entry of view.entries) {
    push(entryLines(entry, view, options));
    lines.push(line('', 'text'));
  }

  const thinking = revealedReasoning(view).trim();
  if (thinking !== '') {
    // Live thinking, tail only: the point is "it is working", not a full transcript of the
    // reasoning that is about to be replaced by the recorded blocks anyway.
    const rows = wrap(thinking, Math.max(8, options.width - 4));
    const glyph = THINKING[Math.floor(options.now / 120) % THINKING.length] ?? '✻';
    lines.push(line(`${glyph} 思考中…`, 'textDim'));
    for (const row of rows.slice(-6)) lines.push(line(`  │ ${row}`, 'textDim'));
  }

  for (const tool of view.pendingTools) {
    // A long command used to be invisible until it finished. The running card is the
    // same shape as its result, so the transcript does not jump when the result lands.
    const summary = callSummary(view.calls[tool.callId]?.input);
    push({
      lines: runningToolLines(tool.name, summary, options.width, options.now, view.toolOutput[tool.callId]),
      images: [],
    });
    lines.push(line('', 'text'));
  }

  if (view.streaming !== '') {
    lines.push(...wrap(view.streaming, options.width).map((row) => line(row, 'assistant')));
  }

  return { lines, images };
}

function entryLines(entry: Entry, view: TuiView, options: TranscriptOptions): TranscriptLines {
  switch (entry.kind) {
    case 'user':
      return { lines: userMessageLines(entry, options.width), images: [] };
    case 'assistant':
      return { lines: assistantMessageLines(entry, options.width, view.thinkingExpanded), images: [] };
    case 'tool': {
      // The whole card is the click target: a title-only target would be a smaller hit area
      // for the same action, and the rows already carry the id for the loop to decode.
      const part = toolCardLines(entry, view, options.width);
      return { lines: part.lines.map((row) => ({ ...row, hit: `tool:${entry.callId}` })), images: part.images };
    }
    case 'notice':
      return { lines: noticeLines(entry.level, entry.text, options.width), images: [] };
  }
}
