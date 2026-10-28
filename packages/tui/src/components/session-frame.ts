import { COMMANDS, paletteMatches, slashMatches } from '../app/commands.js';
import { atQuery, rankAtCandidates } from '../app/atcomplete.js';
import { copyFor, type Copy } from '../app/copy.js';
import { historyMatches, runningAgents, type TuiView } from '../app/view.js';
import type { ScreenSpec } from '../ui/screen.js';
import { agentPanel } from './agent-panel.js';
import { todoPanel } from './todo-panel.js';
import { approvalCard } from './approval-card.js';
import { planCard } from './plan-card.js';
import { commandPalette } from './palette.js';
import { slashMenu } from './slash-menu.js';
import { statusBar } from './status-bar.js';
import { taskPanel } from './task-panel.js';
import { cronPanel } from './cron-panel.js';
import { sessionPanel } from './session-panel.js';
import { modelDialog, providerDialog } from '../app/dialog.js';
import { providerFormDialog } from './provider-form.js';
import { trustCard } from './trust-card.js';
import { changesPanel } from './changes-panel.js';
import { changedFiles } from '../app/changes.js';
import { asideSpec, leftRailSpec } from '../app/rails.js';
import { permissionsPanel } from './permissions-panel.js';
import { transcriptBlocks } from './transcript.js';
import { choiceBlock, type SceneNode } from '../ui/scene.js';

export interface FrameOptions {
  readonly width: number;
  readonly now: number;
  readonly height?: number;
  readonly cwd?: string;
  readonly rails?: boolean;
  readonly activityRail?: boolean;
}

export function frameOf(view: TuiView, options: FrameOptions): ScreenSpec {
  const dock: SceneNode[] = [];
  if (view.scrollOffset > 0 && view.approval === null && view.plan === null) {
    const paused = copyFor(view.lang);
    dock.push(choiceBlock('back-to-bottom', view.newSinceScroll === 0
      ? paused.backToBottom
      : paused.backToBottomNew.replace('{n}', String(view.newSinceScroll)), { selected: true, hit: 'scroll:bottom' }));
  }
  if (view.approval !== null) dock.push(approvalCard(view.approval, { ...options, cursor: view.approvalCursor }));
  if (view.trust !== null) dock.push(trustCard(view.trust.withheld, view.trustCursor, view.trust.cwd, options.width));
  if (view.plan !== null) dock.push(planCard(view.plan, { width: options.width, cursor: view.planCursor }));
  if (view.taskPanel !== null) dock.push(taskPanel(view.tasks, view.taskPanel.index, options.width, options.now));
  if ((options.activityRail ?? options.rails) === false) {
    if (view.todosVisible && view.todos.length > 0) dock.push(todoPanel(view.todos, options.width));
    if (view.tasks.length > 0) dock.push(taskPanel(view.tasks, 0, options.width, options.now));
    const agents = runningAgents(view);
    if (agents.length > 0) dock.push(agentPanel(agents, options.width, options.now));
  }
  if (view.cronPanel !== null) dock.push(cronPanel(view.cronJobs, view.cronPanel.index, options.width, options.now));
  if (view.sessionPanel !== null) dock.push(sessionPanel(view.sessionList, view.sessionPanel.index, view.sessionId, options.width));
  const questionOpen = (view.approval !== null && view.approval.verdict === null) || view.plan !== null;
  const matches = questionOpen ? [] : slashMatches(view.input);
  if (matches.length > 0) dock.push(slashMenu(matches, view.slashIndex, options.width));
  if (view.changesVisible) dock.push(changesPanel(view, options.width));
  if (view.permissionsVisible) dock.push(permissionsPanel(view, options.width));
  if (view.palette !== null) dock.push(commandPalette(paletteMatches(view), view.palette.index, options.width));
  const dialog = view.providerForm !== null
    ? providerFormDialog(view.providerForm)
    : view.modelPanel !== null
      ? modelDialog(view.modelList, view.modelCurrent, view.modelPanel.query)
      : view.providerPanel !== null
        ? view.providerEdit !== null ? providerEditDialog(view) : providerDialog(view.providerList, view.providerPanel.query)
        : undefined;
  return {
    body: transcriptBlocks(view, options),
    dock,
    leftRail: leftRailSpec(view, runningAgents(view), options.now),
    ...(options.cwd === undefined
      ? { aside: asideSpec(view, {}, changedFiles(view)) }
      : { aside: asideSpec(view, { cwd: options.cwd }, changedFiles(view)) }),
    ...(dialog === undefined ? {} : { dialog }),
    status: statusBar(view, options),
    placeholder: placeholderFor(view, copyFor(view.lang)),
    scroll: view.scrollOffset,
  };
}

function providerEditDialog(view: TuiView): import('../app/dialog.js').DialogSpec {
  const edit = view.providerEdit;
  if (edit === null) return { title: '', groups: [], footer: [] };
  const fieldLabel = edit.field === 'name' ? '服务商 ID' : edit.field === 'baseUrl' ? 'Base URL' : 'API Key 环境变量名';
  const placeholder = edit.field === 'name'
    ? '例如 deepseek'
    : edit.field === 'baseUrl' ? '例如 https://api.deepseek.com/v1' : '例如 DEEPSEEK_API_KEY（密钥本身走环境变量）';
  return {
    title: edit.field === 'name' ? '新增服务商' : `编辑 ${edit.name} · ${fieldLabel}`,
    input: { placeholder, value: edit.value }, groups: [],
    footer: [{ key: 'enter', label: '提交' }, { key: 'esc', label: '取消' }],
  };
}

export function titleOf(version: string): string {
  return `CowCat ${version}`;
}

function placeholderFor(view: TuiView, copy: Copy): string {
  if (view.historySearch !== null) return `历史搜索：${view.input} · ${String(historyMatches(view).length)} 条 · Enter 填回 · Esc 取消`;
  if (view.palette !== null) return '↑↓ 选命令 · 回车执行 · Esc 关掉';
  if (view.approval !== null && view.approval.verdict === null) return `${view.approval.name}：${copy.approveKeys}`;
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
