import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

export interface CommandContext {
  readonly args: readonly string[];
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Present so `serve` can be driven by a test without touching the process streams. */
  readonly stdin?: Readable;
  readonly stdoutStream?: Writable;
  readonly diagnostics?: (line: string) => void;
}

interface CommandBase {
  readonly name: string;
  readonly summary: string;
  /** Positional arguments, validated before the handler runs. */
  readonly args: z.ZodType<readonly string[]>;
  readonly usage: string;
  readonly isDefault?: boolean;
}

/**
 * A command that cannot work yet is in the table and says why. A help screen that
 * listed `run` as if it worked would be the same lie as a host that answers an empty
 * success.
 *
 * The union (rather than `status` plus an optional handler) is what keeps the two
 * apart: a blocked command has no handler to call by mistake.
 */
export type CommandSpec =
  | (CommandBase & { readonly status: 'ready'; readonly run: (context: CommandContext) => Promise<number> })
  | (CommandBase & { readonly status: 'blocked'; readonly blockedBy: string });

const noArgs = z.tuple([]);

/**
 * The subcommand table is data (ADR-060), for the same reason the protocol's method
 * table is: help text, argument validation and dispatch all read it, so a command
 * cannot be added to one and forgotten in another. Six verbs, one level, no nesting.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'tui',
    summary: '启动 TUI（无参数时的默认命令）',
    args: noArgs,
    usage: 'cowcat',
    status: 'blocked',
    blockedBy: 'T7（opentui 骨架、project() 与组件）',
    isDefault: true,
  },
  {
    name: 'serve',
    summary: 'headless 协议服务（stdio，一行一个 JSON）',
    args: noArgs,
    usage: 'cowcat serve',
    status: 'ready',
    run: async (context) => {
      // Imported here rather than at the top of the module: `--help` and `doctor` do
      // not need the protocol graph, and the TUI verb (T7) will need the renderer.
      const { serve } = await import('../serve/serve.js');
      const { refusingHost } = await import('../serve/refusing-host.js');
      return serve({
        host: refusingHost(),
        ...(context.stdin === undefined ? {} : { input: context.stdin }),
        ...(context.stdoutStream === undefined ? {} : { output: context.stdoutStream }),
        diagnostics: context.diagnostics ?? context.stderr,
      });
    },
  },
  {
    name: 'run',
    summary: '一次性回合（非交互）',
    // The prompt is required; that is the whole argument contract for now.
    args: z.tuple([z.string().min(1)]),
    usage: 'cowcat run "<prompt>"',
    status: 'blocked',
    blockedBy: 'T4a（组合根：模型、七个工具、策略与审批桥）',
  },
  {
    name: 'doctor',
    summary: '环境、原生核心与协议版本逐项检查',
    args: noArgs,
    usage: 'cowcat doctor',
    status: 'ready',
    run: async (context) => {
      const { runDoctor } = await import('./doctor.js');
      return runDoctor(context);
    },
  },
  {
    name: 'sessions',
    summary: '会话管理：list | resume <id>',
    args: z.union([z.tuple([z.literal('list')]), z.tuple([z.literal('resume'), z.string().min(1)])]),
    usage: 'cowcat sessions list | resume <id>',
    status: 'blocked',
    blockedBy: 'T4a（会话存储与宿主）',
  },
  {
    name: 'setup',
    summary: '交互式配置向导',
    args: noArgs,
    usage: 'cowcat setup',
    status: 'blocked',
    blockedBy: 'T4a（配置键与写入路径）',
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function defaultCommand(): CommandSpec {
  const found = COMMANDS.find((command) => command.isDefault === true);
  if (found === undefined) throw new Error('the command table has no default command');
  return found;
}
