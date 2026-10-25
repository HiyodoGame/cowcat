import { COMMANDS, paletteMatches, slashMatches } from '../app/commands.js';
import { atQuery, rankAtCandidates } from '../app/atcomplete.js';
import { copyFor, type Copy } from '../app/copy.js';
import { historyMatches, runningAgents, type TuiView } from '../app/view.js';
import type { ScreenSpec } from '../ui/screen.js';
import { line, type Line } from '../ui/line.js';
import { agentPanelLines } from './agent-panel.js';
import { approvalCardLines } from './approval-card.js';
import { planCardLines } from './plan-card.js';
import { paletteLines } from './palette.js';
import { slashMenuLines } from './slash-menu.js';
import { statusLine } from './status-bar.js';
import { taskPanelLines } from './task-panel.js';
import { cronPanelLines } from './cron-panel.js';
import { sessionPanelLines } from './session-panel.js';
import { modelPanelLines } from './model-panel.js';
import { trustCardLines } from './trust-card.js';
import { changesPanelLines } from './changes-panel.js';
import { permissionsPanelLines } from './permissions-panel.js';
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
  /** The terminal's rows, so the dock can be capped. Omitted by tests that only pin width. */
  readonly height?: number;
}

export function frameOf(view: TuiView, options: FrameOptions): ScreenSpec {
  const transcript = transcriptLines(view, options);
  const body = [...transcript.lines];
  const images = [...transcript.images];

  // Fixed panels, in priority order: a question first, then the way back to the tail, then
  // what is running, then the plan. They live in the dock so scrolling the transcript cannot
  // move them (ADR-101).
  const dock: Line[] = [];
  // ADR-105: the one affordance for "there is newer output below you". It goes first, which
  // puts it directly under the transcript, and exists only while the reader is scrolled up —
  // an always-present button would be chrome on a screen that already follows the tail.
  // A pending question outranks it: the answer is what that screen is about. Plan reviews
  // count as a question too (review of #167, P2-9).
  if (view.scrollOffset > 0 && view.approval === null && view.plan === null) {
    const paused = copyFor(view.lang);
    dock.push(
      line(
        view.newSinceScroll === 0
          ? paused.backToBottom
          : paused.backToBottomNew.replace('{n}', String(view.newSinceScroll)),
        'act',
        true,
        'scroll:bottom',
      ),
    );
  }
  if (view.approval !== null) {
    dock.push(...approvalCardLines(view.approval, { ...options, cursor: view.approvalCursor }));
  }
  // The pre-session trust question outranks everything but an approval (ADR-157 ①): it
  // is the reason the session has not started yet.
  if (view.trust !== null) {
    dock.push(...trustCardLines(view.trust.withheld, view.trustCursor, view.trust.cwd, options.width));
  }
  if (view.plan !== null) {
    dock.push(...planCardLines(view.plan, { width: options.width, cursor: view.planCursor }));
  }
  if (view.taskPanel !== null) {
    dock.push(...taskPanelLines(view.tasks, view.taskPanel.index, options.width, options.now));
  }
  if (view.cronPanel !== null) {
    dock.push(...cronPanelLines(view.cronJobs, view.cronPanel.index, options.width, options.now));
  }
  if (view.sessionPanel !== null) {
    dock.push(...sessionPanelLines(view.sessionList, view.sessionPanel.index, view.sessionId, options.width));
  }
  if (view.modelPanel !== null) {
    dock.push(...modelPanelLines(view.modelList, view.modelPanel.index, view.modelCurrent, view.modelPanel.preset, options.width));
  }
  // An ANSWERED approval lingers on screen until its turn ends (project.ts keeps it with
  // the verdict) — that is a record, not an open question, so it hides the menu only while
  // the verdict is still pending, the same condition the keymap uses for the arrows.
  const questionOpen = (view.approval !== null && view.approval.verdict === null) || view.plan !== null;
  const matches = questionOpen ? [] : slashMatches(view.input);
  if (matches.length > 0) {
    dock.push(...slashMenuLines(matches, view.slashIndex, options.width));
  }
  const agents = runningAgents(view);
  if (agents.length > 0) {
    dock.push(...agentPanelLines(agents, options.width, options.now));
  }
  if (view.todosVisible && view.todos.length > 0) {
    dock.push(...todoPanelLines(view.todos, options.width));
  }
  if (view.changesVisible) {
    dock.push(...changesPanelLines(view, options.width));
  }
  if (view.permissionsVisible) {
    dock.push(...permissionsPanelLines(view, options.width));
  }
  if (view.palette !== null) {
    dock.push(...paletteLines(paletteMatches(view), view.palette.index, options.width));
  }
  const maxDock = options.height === undefined ? dock.length : Math.max(3, Math.floor(options.height * 0.4));

  return {
    body,
    dock: dock.slice(0, maxDock),
    images,
    status: statusLine(view, options),
    placeholder: placeholderFor(view, copyFor(view.lang)),
    scroll: view.scrollOffset,
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
  if (view.historySearch !== null) return `历史搜索：${view.input} · ${String(historyMatches(view).length)} 条 · Enter 填回 · Esc 取消`;
  if (view.palette !== null) return '↑↓ 选命令 · 回车执行 · Esc 关掉';
  if (view.approval !== null && view.approval.verdict === null) {
    return `${view.approval.name}：${copy.approveKeys}`;
  }
  if (view.plan !== null) return '方案待选：↑↓ + 回车，或输入方案序号';
  const state = view.turn?.state;
  if (state !== undefined && !TERMINAL.has(state)) return copy.busy;
  if (view.closed) return '连接已断开';
  return atHint(view) ?? slashHint(view.input) ?? copy.inputPlaceholder;
}

function atHint(view: TuiView): string | null {
  const query = atQuery(view.input);
  if (query === null) return null;
  const matches = rankAtCandidates(query, view.fileCandidates);
  if (matches.length === 0) return `@${query}：没有匹配文件`;
  return `@${query} 候选：${matches.slice(0, 3).join(' · ')}`;
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
