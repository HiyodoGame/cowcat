import { COMMANDS, paletteMatches, slashMatches } from '../app/commands.js';
import { atQuery, rankAtCandidates } from '../app/atcomplete.js';
import { copyFor, type Copy } from '../app/copy.js';
import { historyMatches, runningAgents, type AgentView, type TuiView } from '../app/view.js';
import type { ScreenSpec } from '../ui/screen.js';
import { line, runLine, type Line } from '../ui/line.js';
import { padTo, truncate } from '../text/width.js';
import { agentPanelLines } from './agent-panel.js';
import { cowCatArt } from './cowcat-art.js';
import { todoPanelLines } from './todo-panel.js';
import { approvalCardLines } from './approval-card.js';
import { planCardLines } from './plan-card.js';
import { paletteLines } from './palette.js';
import { slashMenuLines } from './slash-menu.js';
import { statusLine } from './status-bar.js';
import { taskPanelLines } from './task-panel.js';
import { cronPanelLines } from './cron-panel.js';
import { sessionPanelLines } from './session-panel.js';
import { modelDialog, providerDialog } from '../app/dialog.js';
import { trustCardLines } from './trust-card.js';
import { changesPanelLines } from './changes-panel.js';
import { changedFiles } from '../app/changes.js';
import { permissionsPanelLines } from './permissions-panel.js';
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
  /**
   * The working directory, injected like `now` because the frame is a pure function
   * (ADR-163): the aside names the workspace, and a component that read `process` would
   * not be one.
   */
  readonly cwd?: string;
  /**
   * Whether the three-column rails are mounted (ADR-167 ②). False — a narrow terminal —
   * puts todos/tasks/agents back in the dock: the classic layout, nothing silently lost.
   */
  readonly rails?: boolean;
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
  // Tasks/agents/todos moved to the LEFT RAIL (ADR-167); the dock keeps only modal
  // cards (approval, plan) — things that belong to the conversation's turn. A keyed
  // panel (the /tasks cursor view) still shows inline when the user opened it.
  if (view.taskPanel !== null) {
    dock.push(...taskPanelLines(view.tasks, view.taskPanel.index, options.width, options.now));
  }
  if (options.rails === false) {
    // Narrow terminal: the rails are not mounted, so the run-state views live here —
    // the classic layout, nothing lost (ADR-167 ②).
    if (view.todosVisible && view.todos.length > 0) {
      dock.push(...todoPanelLines(view.todos, options.width));
    }
    if (view.tasks.length > 0) {
      dock.push(...taskPanelLines(view.tasks, 0, options.width, options.now));
    }
    const agents = runningAgents(view);
    if (agents.length > 0) {
      dock.push(...agentPanelLines(agents, options.width, options.now));
    }
  }
  if (view.cronPanel !== null) {
    dock.push(...cronPanelLines(view.cronJobs, view.cronPanel.index, options.width, options.now));
  }
  if (view.sessionPanel !== null) {
    dock.push(...sessionPanelLines(view.sessionList, view.sessionPanel.index, view.sessionId, options.width));
  }
  // An ANSWERED approval lingers on screen until its turn ends (project.ts keeps it with
  // the verdict) — that is a record, not an open question, so it hides the menu only while
  // the verdict is still pending, the same condition the keymap uses for the arrows.
  const questionOpen = (view.approval !== null && view.approval.verdict === null) || view.plan !== null;
  const matches = questionOpen ? [] : slashMatches(view.input);
  if (matches.length > 0) {
    dock.push(...slashMenuLines(matches, view.slashIndex, options.width));
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

  // The modal dialog (ADR-166): configuration choices float above everything as real
  // components; the dock keeps only the run-state views (tasks, cron, todos).
  const dialog =
    view.modelPanel !== null
      ? modelDialog(view.modelList, view.modelCurrent, view.modelPanel.query)
      : view.providerPanel !== null
        ? view.providerEdit !== null
          ? providerEditDialog(view)
          : providerDialog(view.providerList, view.providerPanel.query)
        : undefined;

  return {
    body,
    dock: dock.slice(0, maxDock),
    leftRail: leftRailLines(view, runningAgents(view), options),
    aside: asideLines(view, options),
    ...(dialog === undefined ? {} : { dialog }),
    images,
    status: statusLine(view, options),
    placeholder: placeholderFor(view, copyFor(view.lang)),
    scroll: view.scrollOffset,
  };
}

/** The Connect 式 input step: one field, typed in the dialog, enter submits (ADR-166 ③). */
function providerEditDialog(view: TuiView): import('../app/dialog.js').DialogSpec {
  const edit = view.providerEdit;
  if (edit === null) return { title: '', groups: [], footer: [] };
  const fieldLabel = edit.field === 'name' ? '服务商 ID' : edit.field === 'baseUrl' ? 'Base URL' : 'API Key 环境变量名';
  const placeholder =
    edit.field === 'name'
      ? '例如 deepseek'
      : edit.field === 'baseUrl'
        ? '例如 https://api.deepseek.com/v1'
        : '例如 DEEPSEEK_API_KEY（密钥本身走环境变量）';
  return {
    title: edit.field === 'name' ? '新增服务商' : `编辑 ${edit.name} · ${fieldLabel}`,
    input: { placeholder, value: edit.value },
    groups: [],
    footer: [
      { key: 'enter', label: '提交' },
      { key: 'esc', label: '取消' },
    ],
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

/**
 * The right-rail session facts (ADR-163): what a person glances at — which session, which
 * model, how full the window, what it cost, which directory. Built unconditionally; the
 * screen decides whether the terminal is wide enough to show it.
 */
const ASIDE_COLUMNS = 24;
const ASIDE_LABEL = 4;

/** Columns the LEFT rail occupies (ADR-167 ④); the reading column pays for it. */
export const LEFT_RAIL_WIDTH = 24;

/**
 * The left rail (ADR-167 ①): todos, background tasks, sub-agents, and the mascot —
 * the run-state stack, compact rows without card frames. Anything empty shrinks away;
 * the mascot is always there, because the rail deserves a face.
 */
function leftRailLines(view: TuiView, agents: readonly AgentView[], options: FrameOptions): readonly Line[] {
  const out: Line[] = [];
  const width = LEFT_RAIL_WIDTH - 1;
  const group = (title: string, rows: readonly Line[]): void => {
    if (rows.length === 0) return;
    if (out.length > 0) out.push(line('', 'text'));
    out.push(line(truncate(title, width), 'brand', true));
    out.push(...rows);
  };

  if (view.todosVisible && view.todos.length > 0) {
    const rows = view.todos.map((todo) => {
      const marker = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[▸]' : '[ ]';
      const text = todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content;
      return line(truncate(`${marker} ${text}`, width), todo.status === 'completed' ? 'textDim' : 'text');
    });
    group(`待办 ${String(view.todos.filter((todo) => todo.status === 'completed').length)}/${String(view.todos.length)}`, rows);
  }

  group('后台任务', view.tasks.map((task) => {
    const state = task.state === 'running' ? '▸' : task.state === 'unknown' ? '?' : '·';
    return line(truncate(`${state} ${task.command.split('\n')[0] ?? ''}`, width), task.state === 'running' ? 'act' : 'textDim');
  }));

  group('子代理', agents.map((agent) => {
    const seconds = Math.max(0, Math.round((options.now - agent.startedAt) / 1000));
    const elapsed = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
    return line(truncate(`▸ ${agent.role} · ${elapsed}`, width), 'act');
  }));

  if (out.length > 0) out.push(line('', 'text'));
  out.push(...cowCatArt(runningAgents(view).length > 0 || (view.turn !== null && view.turn.state === 'streaming') ? 'running' : 'idle', options.now));
  return out;
}

function asideLines(view: TuiView, options: FrameOptions): readonly Line[] {
  const out: Line[] = [];
  /** One titled group; skipped entirely when it has nothing to say, blank row between groups. */
  const group = (title: string, rows: readonly (readonly [string, string])[]): void => {
    if (rows.length === 0) return;
    const last = out.at(-1);
    if (last !== undefined && last.text !== '') out.push(line('', 'text'));
    out.push(runLine('', [{ text: title, token: 'brand', bold: true }], ''));
    for (const [label, value] of rows) {
      out.push(runLine('', [
        { text: padTo(label, ASIDE_LABEL), token: 'textDim' },
        { text: truncate(value, ASIDE_COLUMNS - ASIDE_LABEL - 1), token: 'text' },
      ], ''));
    }
  };
  if (view.usage !== null && view.contextWindow !== null && view.contextWindow > 0) {
    const used = view.usage.input + view.usage.cacheRead + view.usage.cacheCreation + view.usage.output;
    const spent = sessionSpent(view);
    group('上下文', [
      ['窗口', `${String(Math.round((used / view.contextWindow) * 100))}%`],
      ['累计', `↑${String(view.usageTotals.input)} ↓${String(view.usageTotals.output)}`],
      ...(spent === null ? [] : [['费用', spent] as readonly [string, string]]),
    ]);
  }
  group('会话', [
    ['模型', view.model ?? '（未记录）'],
    ...(view.sessionId === null ? [] : [['id', view.sessionId] as readonly [string, string]]),
  ]);
  if (options.cwd !== undefined) group('工作区', [['目录', options.cwd]]);

  // git 及文件预览 (ADR-167 ①): this session's changed files, newest understanding of
  // the working tree — the Write/Edit transcript folded into one glance.
  const files = changedFiles(view);
  if (files.length > 0) {
    const last = out.at(-1);
    if (last !== undefined && last.text !== '') out.push(line('', 'text'));
    out.push(runLine('', [{ text: 'git 变更', token: 'brand', bold: true }], ''));
    for (const file of files.slice(0, 8)) {
      const name = file.path.split(/[\\/]/).slice(-1)[0] ?? file.path;
      const stat = file.added > 0 || file.removed > 0
        ? `+${String(file.added)} -${String(file.removed)}`
        : `写入 ${String(file.written)} 行`;
      out.push(runLine('', [
        { text: truncate(name, ASIDE_COLUMNS - 10), token: 'text' },
        { text: ` ${stat}`, token: file.added >= file.removed ? 'brand' : 'alert' },
      ], ''));
    }
    if (files.length > 8) out.push(line(`… 另有 ${String(files.length - 8)} 个文件（/changes）`, 'textDim'));
  }
  return out;
}

/** The session's summed cost, in the same terms the /cost panel uses; null when unpriced. */
function sessionSpent(view: TuiView): string | null {
  const price = view.price;
  if (price === null) return null;
  const total =
    view.usageTotals.input * price.input +
    view.usageTotals.output * price.output +
    view.usageTotals.cacheRead * (price.cacheRead ?? 0) +
    view.usageTotals.cacheCreation * (price.cacheCreation ?? 0);
  return `$${total.toFixed(2)}`;
}
