import { COMMANDS } from '../app/commands.js';
import { copyFor, type Copy } from '../app/copy.js';
import { runningAgents, type TuiView } from '../app/view.js';
import type { ScreenSpec } from '../ui/screen.js';
import { line } from '../ui/line.js';
import { agentPanelLines } from './agent-panel.js';
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
  const transcript = transcriptLines(view, options);
  const body = [...transcript.lines];
  const images = [...transcript.images];

  if (view.todosVisible && view.todos.length > 0) {
    body.push(line('', 'text'), ...todoPanelLines(view.todos, options.width));
  }
  const agents = runningAgents(view);
  if (agents.length > 0) {
    body.push(line('', 'text'), ...agentPanelLines(agents, options.width, options.now));
  }
  if (view.palette !== null) {
    body.push(line('', 'text'), ...paletteLines(COMMANDS, view.palette.index, options.width));
  }

  return {
    body,
    images,
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
  return slashHint(view.input) ?? copy.inputPlaceholder;
}

/**
 * What to type after `/`, inline.
 *
 * The palette (Ctrl-P) has always listed the commands, but nothing told a person that `/`
 * was a way in — the measured complaint was "there is no / command hint". Only the input line
 * has room for this without pushing the transcript, so the hint goes there.
 */
function slashHint(input: string): string | null {
  if (!input.startsWith('/')) return null;
  const typed = input.trim();
  if (typed.includes(' ')) return null;
  const matches = COMMANDS.filter((command) => `/${command.name}`.startsWith(typed));
  if (matches.length === 0) return '没有这个命令 · Ctrl-P 看全部';
  const shown = matches.slice(0, 3).map((command) => `/${command.name} ${command.summary}`).join(' · ');
  return matches.length > 3 ? `${shown} · 共 ${String(matches.length)} 个（Ctrl-P 看全部）` : shown;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
