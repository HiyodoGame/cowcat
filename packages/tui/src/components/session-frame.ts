import { COMMANDS } from '../app/commands.js';
import { copyFor, type Copy } from '../app/copy.js';
import type { TuiView } from '../app/view.js';
import type { ScreenSpec } from '../ui/screen.js';
import { line } from '../ui/line.js';
import { paletteLines } from './palette.js';
import { statusLine } from './status-bar.js';
import { todoPanelLines } from './todo-panel.js';
import { transcriptLines } from './transcript.js';

/**
 * The session frame: the brand guide's skeleton, as data (§4.1).
 *
 * ```
 * ┌─ banner：CowCat + 版本 ──────────────────────┐
 * │ 对话流（卡片）                                 │
 * │ 待办面板 / 命令面板（出现时）                   │
 * ├──────────────────────────────────────────────┤
 * │ 状态条（会话 · 状态 · 待办 · 用量）             │
 * │ 输入区                                        │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * Two parameters, both injected rather than read: `width` (how many columns the cards have to
 * fit in, which only the renderer knows) and `now` (only the nudge needs it). Everything else
 * comes from the view, so the whole screen is a pure function of `(view, width, now)` — and a
 * frame snapshot is therefore a test of the screen, not a photograph of a process.
 */
export interface FrameOptions {
  readonly width: number;
  readonly now: number;
}

export function frameOf(view: TuiView, options: FrameOptions): ScreenSpec {
  const body = [...transcriptLines(view, options)];

  if (view.todosVisible && view.todos.length > 0) {
    body.push(line('', 'text'), ...todoPanelLines(view.todos, options.width));
  }
  if (view.palette !== null) {
    body.push(line('', 'text'), ...paletteLines(COMMANDS, view.palette.index, options.width));
  }

  return {
    body,
    status: statusLine(view, options),
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
  if (view.palette !== null) return '↑↓ 选命令 · 回车执行 · Esc 关掉';
  if (view.approval !== null && view.approval.verdict === null) {
    return `${view.approval.name}：${copy.approveKeys}`;
  }
  const state = view.turn?.state;
  if (state !== undefined && !TERMINAL.has(state)) return copy.busy;
  if (view.closed) return '连接已断开';
  return copy.inputPlaceholder;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
