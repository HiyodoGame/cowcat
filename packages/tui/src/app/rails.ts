import { mascotFrames } from '../components/cowcat-art.js';
import type { AgentView, TuiView, TodoView } from './view.js';

/**
 * The two rails' structured data (ADR-167 → ADR-168): the rails are COMPONENTS now —
 * titled panels with a coloured header and pooled row renderables — so their specs are
 * data, not pre-drawn text lines. `frameOf` produces these; the screen mounts them.
 */

export interface RailRow {
  readonly text: string;
  /** Dim = secondary/finished; accent = running/active. Default is the body voice. */
  readonly dim?: boolean;
  readonly accent?: boolean;
}

export interface RailPanel {
  readonly title: string;
  readonly rows: readonly RailRow[];
}

export interface LeftRailSpec {
  readonly panels: readonly RailPanel[];
  /** The mascot's ASCII lines; its mood travels separately so the screen can animate. */
  readonly mascot: readonly string[];
  readonly mascotState: 'idle' | 'running';
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

/** One panel's worth of todo rows; hidden entirely when the list is empty or closed. */
function todoPanel(todos: readonly TodoView[], visible: boolean): RailPanel | null {
  if (!visible || todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return {
    title: `待办 ${String(done)}/${String(todos.length)}`,
    rows: todos.map((todo) => {
      const text = todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content;
      return {
        text,
        ...(todo.status === 'completed' ? { dim: true } : {}),
        ...(todo.status === 'in_progress' ? { accent: true } : {}),
      };
    }),
  };
}

/** Everything the left rail shows, as data (ADR-168). Empty panels shrink away. */
export function leftRailSpec(
  view: { readonly todos: readonly TodoView[]; readonly todosVisible: boolean; readonly tasks: readonly { readonly command: string; readonly state: string }[] },
  agents: readonly AgentView[],
  now: number,
): LeftRailSpec {
  const panels: RailPanel[] = [];
  const todos = todoPanel(view.todos, view.todosVisible);
  if (todos !== null) panels.push(todos);
  if (view.tasks.length > 0) {
    panels.push({
      title: '后台任务',
      rows: view.tasks.map((task) => ({
        text: task.command.split('\n')[0] ?? '',
        ...(task.state === 'running' ? { accent: true } : { dim: true }),
      })),
    });
  }
  if (agents.length > 0) {
    panels.push({
      title: '子代理',
      rows: agents.map((agent) => {
        const seconds = Math.max(0, Math.round((now - agent.startedAt) / 1000));
        const elapsed = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
        return { text: `${agent.role} · ${elapsed}`, accent: true };
      }),
    });
  }
  const running = agents.length > 0 || view.tasks.some((task) => task.state === 'running');
  return { panels, mascot: mascotFrames(running ? 'running' : 'idle', now), mascotState: running ? 'running' : 'idle' };
}

/** Everything the right rail shows: session facts, then the git working-tree view. */
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
    rows: [
      { label: '模型', value: view.model ?? '（未记录）' },
      ...(view.sessionId === null ? [] : [{ label: 'id', value: view.sessionId }]),
    ],
  });
  const workspace: AsideRow[] = options.cwd === undefined ? [] : [{ label: '目录', value: options.cwd }];
  if (workspace.length > 0) panels.push({ title: '工作区', rows: workspace });

  if (changedFiles.length > 0) {
    panels.push({
      title: 'git 变更',
      rows: changedFiles.slice(0, 10).map((file) => {
        const name = file.path.split(/[\\/]/).slice(-1)[0] ?? file.path;
        const stat = file.added > 0 || file.removed > 0
          ? `+${String(file.added)} -${String(file.removed)}`
          : `写入 ${String(file.written)} 行`;
        return {
          label: name,
          value: stat,
          ...(file.added >= file.removed ? {} : { valueAccent: true }),
        };
      }),
    });
  }
  return { panels };
}

function sessionCost(
  totals: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheCreation: number },
  price: { readonly input: number; readonly output: number; readonly cacheRead?: number | undefined; readonly cacheCreation?: number | undefined } | null,
): string | null {
  if (price === null) return null;
  const total =
    totals.input * price.input +
    totals.output * price.output +
    totals.cacheRead * (price.cacheRead ?? 0) +
    totals.cacheCreation * (price.cacheCreation ?? 0);
  return `$${total.toFixed(2)}`;
}
