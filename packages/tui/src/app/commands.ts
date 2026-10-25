import type { TuiView } from './view.js';
import { closePalette, toggleChanges, toggleExpanded, toggleThinking, toggleTodos } from './view.js';

/**
 * The commands, and the effects they can ask for.
 *
 * One table serves both ways in: typing `/todos` in the input and picking "todos" in the
 * palette run the same function, so the two can never disagree about what a command does
 * (the same reason ADR-060 made the CLI's subcommand table data).
 *
 * A command returns an EFFECT rather than doing the work, because two of them (cancel, quit)
 * are about the loop and not about the view — and a table that closed over the socket would
 * be a table no test could run.
 */
export type CommandEffect =
  | { readonly kind: 'view'; readonly view: TuiView }
  | { readonly kind: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly text: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'quit' }
  /** Ask the loop for the session list; it is the only thing here that needs the client. */
  | { readonly kind: 'sessions'; readonly all: boolean }
  /** Open the `/model` picker (ADR-161 ②); the loop fetches the host's list. */
  | { readonly kind: 'modelPanel' }
  /** Open the background-task panel (ADR-113); the loop owns the stop call. */
  | { readonly kind: 'tasks' }
  /** Open the `/cron` panel (ADR-143 ③); the loop owns the list and delete calls. */
  | { readonly kind: 'cron' }
  /** Fork the current session (ADR-127); the loop calls `session.fork`. */
  | { readonly kind: 'fork' }
  /** Toggle plan mode (ADR-124 ⑥); the loop calls `plan.setMode` with the new state. */
  | { readonly kind: 'plan'; readonly enabled: boolean }
  | { readonly kind: 'model'; readonly preset: string | null; readonly effort: string | null | undefined }
  | { readonly kind: 'compact' }
  | { readonly kind: 'cost' }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'export'; readonly path: string | null }
  | { readonly kind: 'permissions' }
  | { readonly kind: 'revokeGrant'; readonly grantId: string }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' };

export interface TuiCommand {
  /** As typed, without the slash. */
  readonly name: string;
  readonly summary: string;
  readonly run: (view: TuiView, rest?: string) => CommandEffect;
}

export const KEYS_HELP = [
  '回车 发送（审批时：↑↓ 选择 + 回车确认，y / n / always / s 也可）',
  '换行：Ctrl+J 或 Ctrl+Enter（任何终端都行）；Alt+Enter 多数终端可用；Shift+Enter 只在支持 kitty 协议的终端上有效',
  'Esc 取消正在跑的回合；菜单/面板开着时关掉它；空闲时快速按两次 Esc 取回上一条输入',
  'Shift+Tab 循环模式：正常 → 接受编辑 → plan → 正常 · Ctrl+L 回到底部并重绘',
  '空输入 ↑↓ 滚动 · PageUp/PageDown 翻页 · Ctrl+End 回到底部',
  'Ctrl-P 命令面板 · Ctrl-O 展开/折叠最后一张工具卡 · Ctrl-T 思考内容',
  'Ctrl-C 取消回合/清空输入/再按一次退出 · Ctrl+D 空输入退出 · /exit 或 /quit 退出',
  '直接输入 /命令 也可以（/help 看这个列表）',
  '恢复会话：退出后用 cowcat sessions list 看 id，再 cowcat sessions resume <id>',
].join('　');

export const COMMANDS: readonly TuiCommand[] = [  {
    name: 'todos',
    summary: '显示 / 隐藏待办面板',
    run: (view) => ({ kind: 'view', view: toggleTodos(closePalette(view)) }),
  },
  {
    name: 'expand',
    summary: '展开 / 折叠最后一张工具卡',
    run: (view) => {
      const callId = lastToolCallId(view);
      if (callId === null) return { kind: 'notice', level: 'info', text: '这一回合还没有工具卡。' };
      return { kind: 'view', view: toggleExpanded(closePalette(view), callId) };
    },
  },
  { name: 'cancel', summary: '取消正在跑的回合', run: () => ({ kind: 'cancel' }) },
  {
    name: 'thinking',
    summary: '展开 / 折叠 AI 的思考内容',
    run: (view) => ({ kind: 'view', view: toggleThinking(closePalette(view)) }),
  },
  { name: 'sessions', summary: '本工作区的会话选择器；/sessions all 看全部', run: (_view, rest = '') => ({ kind: 'sessions', all: rest.trim() === 'all' }) },
  { name: 'tasks', summary: '后台任务：查看与终止', run: () => ({ kind: 'tasks' }) },
  { name: 'cron', summary: '定时任务：查看与删除（cron）', run: () => ({ kind: 'cron' }) },
  {
    name: 'skills',
    summary: '本次会话可用的技能',
    run: (view) => ({
      kind: 'notice',
      level: 'info',
      text:
        view.skills.length === 0
          ? '没有可用技能（未发现 SKILL.md，或项目未受信）。'
          : view.skills.map((skill) => `${skill.name}（${skill.layer}/${skill.origin}）`).join('　'),
    }),
  },
  {
    name: 'fork',
    summary: '把当前会话复制成一个新会话（事件重放式，可各自继续）',
    run: () => ({ kind: 'fork' }),
  },
  {
    name: 'plan',
    summary: 'plan 模式开关：开启后只读探索，方案定好请你选',
    run: (view) => ({ kind: 'plan', enabled: !view.planMode }),
  },
  { name: 'help', summary: '键位与用法', run: (view) => ({ kind: 'notice', level: 'info', text: KEYS_HELP.replace('（/help 看这个列表）', '').trim() + `　【${view.sessionId ?? '无会话'}】` }) },
  { name: 'quit', summary: '退出 cowcat', run: () => ({ kind: 'quit' }) },
  {
    name: 'changes',
    summary: '显示 / 隐藏本会话修改的文件',
    run: (view) => ({ kind: 'view', view: toggleChanges(closePalette(view)) }),
  },
  {
    name: 'model',
    summary: '模型选择器；/model <provider/preset> 直达切换',
    run: (_view, rest = '') => (rest.trim() === '' ? { kind: 'modelPanel' as const } : { kind: 'model' as const, preset: rest.trim(), effort: undefined }),
  },
  { name: 'compact', summary: '手动压缩当前会话上下文', run: () => ({ kind: 'compact' }) },
  {
    name: 'config',
    summary: '查看设置或修改 model / effort：/config effort=high',
    run: (view, rest = '') => {
      if (rest.trim() === '') {
        return {
          kind: 'notice',
          level: 'info',
          text: `当前模型：${view.model ?? '尚未记录（下一回合显示）'}；会话内可设置 model 和 effort，例如 /config effort=high`,
        };
      }
      const [key, value] = rest.split('=', 2).map((part) => part.trim());
      if (key === 'model' && value !== undefined && value !== '') return { kind: 'model', preset: value, effort: undefined };
      if (key === 'effort' && value !== undefined && value !== '') return { kind: 'model', preset: null, effort: value };
      return { kind: 'notice', level: 'warn', text: '会话内设置只支持 model 和 effort，例如 /config model=openai/gpt-6.1-sol 或 /config effort=high' };
    },
  },
  { name: 'cost', summary: '显示本会话 token 与成本明细', run: () => ({ kind: 'cost' }) },
  {
    name: 'resume',
    summary: '恢复会话：/resume 弹出本工作区的会话选择；/resume <id> 直达',
    run: (_view, rest = '') => rest.trim() === '' ? { kind: 'sessions', all: false } : { kind: 'resume', sessionId: rest.trim() },
  },
  { name: 'clear', summary: '新建并切换到一个空会话', run: () => ({ kind: 'clear' }) },
  { name: 'copy', summary: '复制最近一条助手回答（OSC52 终端剪贴板）', run: () => ({ kind: 'copy' }) },
  {
    name: 'export',
    summary: '导出会话为 Markdown：/export [path]',
    run: (_view, rest = '') => ({ kind: 'export', path: rest.trim() === '' ? null : rest.trim() }),
  },
  {
    name: 'permissions',
    summary: '查看授权；/permissions revoke <grantId> 撤销',
    run: (_view, rest = '') => {
      const trimmed = rest.trim();
      if (trimmed === '') return { kind: 'permissions' };
      const match = /^revoke\s+(grant_\d+)$/.exec(trimmed);
      if (match?.[1] !== undefined) return { kind: 'revokeGrant', grantId: match[1] };
      return { kind: 'notice', level: 'warn', text: '用法：/permissions 或 /permissions revoke <grantId>' };
    },
  },
  { name: 'undo', summary: '撤销最近一次 CowCat Write / Edit（仅文件变更）', run: () => ({ kind: 'undo' }) },
  { name: 'redo', summary: '重做最近一次撤销（仅文件变更）', run: () => ({ kind: 'redo' }) },
];

export function findCommand(name: string): TuiCommand | undefined {
  return COMMANDS.find((command) => command.name === (name === 'exit' ? 'quit' : name));
}

export function paletteMatches(view: TuiView): readonly TuiCommand[] {
  const query = view.palette?.query.trim().toLowerCase() ?? '';
  if (query === '') return COMMANDS;
  return COMMANDS.filter((command) => `${command.name} ${command.summary}`.toLowerCase().includes(query));
}

export function paletteCommandAt(view: TuiView, row: number): TuiCommand | undefined {
  return paletteMatches(view)[row];
}

/**
 * Commands matching what has been typed so far.
 *
 * Only a bare `/query` counts: once a space is in the input the person is writing a prompt
 * that happens to start with a slash, and stealing Enter for a menu would be wrong.
 */
export function slashMatches(input: string): readonly TuiCommand[] {
  const text = input.trim();
  if (!text.startsWith('/') || /\s/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return COMMANDS.filter((command) => command.name.toLowerCase().startsWith(query));
}

/** `/name rest` → the command and whatever followed it, or `null` when nothing matches. */
export function parseCommand(text: string): { readonly command: TuiCommand; readonly rest: string } | null {
  if (!text.startsWith('/')) return null;
  const [head = '', ...tail] = text.slice(1).split(/\s+/);
  const command = findCommand(head);
  return command === undefined ? null : { command, rest: tail.join(' ') };
}

/** The most recent tool entry's call id — what `/expand` and Ctrl-O act on. */
export function lastToolCallId(view: TuiView): string | null {
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index];
    if (entry?.kind === 'tool') return entry.callId;
  }
  return null;
}
