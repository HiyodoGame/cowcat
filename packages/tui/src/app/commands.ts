import type { TuiView } from './view.js';
import { closePalette, toggleExpanded, toggleThinking, toggleTodos } from './view.js';

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
  | { readonly kind: 'sessions' }
  /** Open the background-task panel (ADR-113); the loop owns the stop call. */
  | { readonly kind: 'tasks' };

export interface TuiCommand {
  /** As typed, without the slash. */
  readonly name: string;
  readonly summary: string;
  readonly run: (view: TuiView) => CommandEffect;
}

export const KEYS_HELP = [
  '回车 发送（审批时：↑↓ 选择 + 回车确认，y / n / always / s 也可）',
  '换行：Ctrl+J 或 Ctrl+Enter（任何终端都行）；Alt+Enter 多数终端可用；Shift+Enter 只在支持 kitty 协议的终端上有效',
  'Esc 取消正在跑的回合；命令面板开着时关掉它',
  'Ctrl-P 命令面板 · Ctrl-O 展开/折叠最后一张工具卡 · Ctrl-T 思考内容 · Ctrl-C 退出',
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
  { name: 'sessions', summary: '列出会话与恢复命令', run: () => ({ kind: 'sessions' }) },
  { name: 'tasks', summary: '后台任务：查看与终止', run: () => ({ kind: 'tasks' }) },
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
  { name: 'help', summary: '键位与用法', run: (view) => ({ kind: 'notice', level: 'info', text: KEYS_HELP.replace('（/help 看这个列表）', '').trim() + `　【${view.sessionId ?? '无会话'}】` }) },
  { name: 'quit', summary: '退出 cowcat', run: () => ({ kind: 'quit' }) },
];

export function findCommand(name: string): TuiCommand | undefined {
  return COMMANDS.find((command) => command.name === name);
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
