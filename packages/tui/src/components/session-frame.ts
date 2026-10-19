import { copyFor, type Copy } from '../app/copy.js';
import type { TuiView } from '../app/view.js';
import type { ScreenSpec } from '../ui/screen.js';
import { statusLine } from './status-bar.js';
import { transcriptLines } from './transcript.js';

/**
 * The session frame: the brand guide's skeleton, as data (§4.1).
 *
 * ```
 * ┌─ banner：CowCat + 版本 ──────────────────────┐
 * │ 对话流                                        │
 * ├──────────────────────────────────────────────┤
 * │ 状态条（模式/会话/待办/用量）                  │
 * │ 输入区                                        │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * The banner is the border's own title so it survives scrolling, the transcript is the
 * flexible middle, and the last two rows are the status line and the input. T8's cards
 * (message / tool / approval / todo / diff) land inside the transcript; the frame itself
 * does not change when they do.
 *
 * This is the only place that decides what goes where, and it is a pure function of the
 * view — so "does the screen say the right thing?" is a test that needs no terminal.
 */
export function frameOf(view: TuiView): ScreenSpec {
  return {
    body: transcriptLines(view),
    status: statusLine(view),
    placeholder: placeholderFor(view, copyFor(view.lang)),
  };
}

/** The banner text. Static, so the border's title is set once, at construction. */
export function titleOf(version: string): string {
  return `CowCat ${version}`;
}

/**
 * What the input line is for right now.
 *
 * An open approval takes the input line over instead of stealing `y`/`n` from it: the
 * keystrokes would otherwise be both an answer and text, and the user would have to guess
 * which one won. While a turn is running the placeholder says so, because a second
 * `turn.send` is refused by the host (`session … already has a turn running`).
 */
function placeholderFor(view: TuiView, copy: Copy): string {
  if (view.approval !== null && view.approval.verdict === null) {
    return `${view.approval.name}：${copy.approveKeys}`;
  }
  const state = view.turn?.state;
  if (state !== undefined && !TERMINAL.has(state)) return copy.busy;
  if (view.closed) return '连接已断开';
  return copy.inputPlaceholder;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
