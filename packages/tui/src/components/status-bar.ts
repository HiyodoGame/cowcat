import { copyFor, type Copy } from '../app/copy.js';
import { costOf, formatCost } from '../app/meter.js';
import { runningAgents, type TuiView } from '../app/view.js';
import { truncate, stringWidth } from '../text/width.js';
import type { TokenName } from '../theme/tokens.js';
import { statusBlock, type StatusFact, type StatusNode } from '../ui/scene.js';

export interface StatusOptions {
  readonly now: number;
  readonly width?: number;
}

export function statusBar(view: TuiView, options: StatusOptions = { now: 0 }): StatusNode {
  const copy = copyFor(view.lang);
  const state = stateOf(view, copy, options.now);
  // Each fact carries a rank: when the row is too narrow, the lowest-ranked facts go first.
  // Display order is the order of the calls below (unchanged); rank only decides what fits.
  const ranked: { readonly fact: StatusFact; readonly rank: number }[] = [];
  const add = (rank: number, fact: StatusFact): void => { ranked.push({ fact, rank }); };
  if (view.planMode) add(1, { label: '模式', value: 'plan' });
  if (view.acceptEdits) add(1, { label: '模式', value: copy.modeAcceptEdits });
  if (view.model !== null) add(5, { label: '模型', value: shortModel(view.model) });
  const elapsed = elapsedOf(view, options.now);
  if (elapsed !== null) add(3, { label: '用时', value: elapsed });
  if (view.scrollOffset > 0) add(2, { label: '新输出', value: String(view.newSinceScroll) });
  if (view.todos.length > 0) {
    const done = view.todos.filter((todo) => todo.status === 'completed').length;
    add(6, { label: '待办', value: `${String(done)}/${String(view.todos.length)}` });
  }
  const background = view.tasks.filter((task) => task.state === 'running').length;
  if (background > 0) add(7, { label: '后台', value: String(background) });
  if (view.usage !== null && view.contextWindow !== null && view.contextWindow > 0) {
    const used = view.usage.input + view.usage.cacheRead + view.usage.cacheCreation + view.usage.output;
    add(4, { label: '上下文', value: `${String(Math.round((used / view.contextWindow) * 100))}%` });
  }
  if (view.usage !== null) add(9, { label: '累计', value: `↑${String(view.usageTotals.input)} ↓${String(view.usageTotals.output)}` });
  if (view.usage !== null && view.price !== null) add(8, { label: '费用', value: formatCost(costOf(view.usageTotals, view.price)) });
  if (view.closed) add(0, { label: '连接', value: '已断开' });
  const width = options.width;

  const chosen = new Set<number>();
  let room = width === undefined ? Number.POSITIVE_INFINITY : Math.max(0, width - stringWidth(state.text));
  const byRank = ranked.map((entry, index) => ({ ...entry, index })).sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const entry of byRank) {
    const cost = stringWidth(` ${entry.fact.label} ${entry.fact.value} `) + 1;
    if (cost <= room) {
      chosen.add(entry.index);
      room -= cost;
    }
  }
  const kept = ranked.filter((_, index) => chosen.has(index)).map((entry) => entry.fact);
  return statusBlock('session-status', width === undefined ? state.text : truncate(state.text, width), kept, state.token);
}

function stateOf(view: TuiView, copy: Copy, now: number): { readonly text: string; readonly token: TokenName } {
  if (view.approval !== null && view.approval.verdict === null) {
    const nudged = now - view.approval.askedAt > 10_000 ? ` ${copy.approvalWaiting}` : '';
    return { text: `${view.approval.name}（${view.approval.rule}）${copy.approvePrompt}${nudged}`, token: 'plan' };
  }
  switch (view.turn?.state) {
    case undefined: return { text: copy.ready, token: 'textDim' };
    case 'completed': return { text: copy.success, token: 'brand' };
    case 'failed': return { text: `${copy.failure}${view.turn.reason === null ? '' : `（${view.turn.reason}）`}`, token: 'alert' };
    case 'cancelled': return { text: copy.cancelled, token: 'textDim' };
    default: return { text: activityOf(view), token: 'act' };
  }
}

function activityOf(view: TuiView): string {
  const agents = runningAgents(view).length;
  const suffix = agents === 0 ? '' : ` · 子 agent ${String(agents)} 个运行中`;
  const state = view.turn?.state;
  if (state === 'awaiting_tools') {
    const names = view.pendingTools.map((tool) => tool.name);
    if (names.length > 0) return `执行 ${[...new Set(names)].join('/')}${suffix}`;
    return `准备执行工具${suffix}`;
  }
  if (state === 'streaming') return `模型输出中${suffix}`;
  if (state === 'finishing') return `收尾中${suffix}`;
  return `等模型响应${suffix}`;
}

function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model;
}

function elapsedOf(view: TuiView, now: number): string | null {
  const state = view.turn?.state;
  if (view.turnStartedAt === null || state === undefined || TERMINAL.has(state)) return null;
  const seconds = Math.max(0, Math.round((now - view.turnStartedAt) / 1000));
  return seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function statusWidth(text: string): number {
  return stringWidth(text);
}
