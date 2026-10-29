import { mascotFrame, mascotState, type MascotState } from '../components/cowcat-art.js';
import { spriteBlock, type SpriteNode } from '../ui/scene.js';
import { animationsEnabled } from './preferences.js';
import { costOf, formatCost } from './meter.js';
import type { AgentView, TuiView, TodoView } from './view.js';

export interface RailRow {
  readonly text: string;
  readonly dim?: boolean;
  readonly accent?: boolean;
}

export interface RailPanel {
  readonly title: string;
  readonly rows: readonly RailRow[];
}

export interface LeftRailSpec {
  readonly panels: readonly RailPanel[];
  readonly mascot: SpriteNode;
  readonly mascotState: MascotState;
  readonly mascotLabel: string;
}

export interface AsideRow {
  readonly label: string;
  readonly value: string;
  readonly valueAccent?: boolean;
}

export interface AsidePanel {
  readonly title: string;
  readonly rows: readonly AsideRow[];
}

export interface AsideSpec {
  readonly panels: readonly AsidePanel[];
}

function todoPanel(todos: readonly TodoView[], visible: boolean): RailPanel {
  const shown = visible ? todos : [];
  const done = shown.filter((todo) => todo.status === 'completed').length;
  return {
    title: `待办 ${String(done)}/${String(shown.length)}`,
    rows: shown.length === 0 ? [{ text: '暂无待办', dim: true }] : shown.map((todo) => ({
      text: todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content,
      ...(todo.status === 'completed' ? { dim: true } : {}),
      ...(todo.status === 'in_progress' ? { accent: true } : {}),
    })),
  };
}

const LABELS: Readonly<Record<MascotState, string>> = {
  idle: '奶牛猫 / 待命', thinking: '奶牛猫 / 思考中', tools: '奶牛猫 / 工作中',
  approval: '奶牛猫 / 等你决定', success: '奶牛猫 / 完成了', failed: '奶牛猫 / 需要关注',
};

export function leftRailSpec(view: TuiView, agents: readonly AgentView[], now: number): LeftRailSpec {
  const panels: RailPanel[] = [todoPanel(view.todos, view.todosVisible)];
  panels.push({
    title: '子代理',
    rows: agents.length === 0 ? [{ text: '暂无运行中的子代理', dim: true }] : agents.map((agent) => {
      const seconds = Math.max(0, Math.round((now - agent.startedAt) / 1000));
      const elapsed = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
      return { text: `${agent.role} · ${elapsed}`, accent: true };
    }),
  });
  panels.push({
    title: '后台任务',
    rows: view.tasks.length === 0 ? [{ text: '暂无后台任务', dim: true }] : view.tasks.map((task) => ({
      text: task.command.split('\n')[0] ?? '',
      ...(task.state === 'running' ? { accent: true } : { dim: true }),
    })),
  });
  const state = mascotState(view, now);
  return { panels, mascot: spriteBlock('cowcat', mascotFrame(state, now, animationsEnabled(process.env))), mascotState: state, mascotLabel: LABELS[state] };
}

export function asideSpec(
  view: TuiView,
  options: { readonly cwd?: string },
  changedFiles: readonly { readonly path: string; readonly added: number; readonly removed: number; readonly written: number }[],
): AsideSpec {
  const panels: AsidePanel[] = [];
  if (view.usage !== null && view.contextWindow !== null && view.contextWindow > 0) {
    const used = view.usage.input + view.usage.cacheRead + view.usage.cacheCreation + view.usage.output;
    const spent = sessionCost(view.usageTotals, view.price);
    panels.push({
      title: '上下文',
      rows: [
        { label: '窗口', value: `${String(Math.round((used / view.contextWindow) * 100))}%` },
        { label: '累计', value: `↑${String(view.usageTotals.input)} ↓${String(view.usageTotals.output)}` },
        ...(spent === null ? [] : [{ label: '费用', value: spent }]),
      ],
    });
  }
  panels.push({
    title: '会话',
    rows: [{ label: '模型', value: view.model ?? '（未记录）' }, ...(view.sessionId === null ? [] : [{ label: 'id', value: view.sessionId }])],
  });
  if (options.cwd !== undefined) panels.push({ title: '工作区', rows: [{ label: '目录', value: options.cwd }] });
  panels.push({
    title: 'CowCat 变更',
    rows: changedFiles.length === 0 ? [{ label: '暂无 CowCat 变更', value: '' }] : changedFiles.slice(0, 10).map((file) => {
      const name = file.path.split(/[\\/]/).slice(-1)[0] ?? file.path;
      const stat = file.added > 0 || file.removed > 0 ? `+${String(file.added)} -${String(file.removed)}` : `写入 ${String(file.written)} 行`;
      return { label: name, value: stat, ...(file.added >= file.removed ? {} : { valueAccent: true }) };
    }),
  });
  return { panels };
}

function sessionCost(
  totals: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheCreation: number },
  price: { readonly input: number; readonly output: number; readonly cacheRead?: number | undefined; readonly cacheCreation?: number | undefined } | null,
): string | null {
  return price === null ? null : formatCost(costOf(totals, price));
}
