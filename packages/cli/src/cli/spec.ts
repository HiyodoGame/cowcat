import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { runDoctor } from './doctor.js';
import type { FlagSpec } from './flags.js';
import { runOneShot } from './oneshot.js';
import { runServe } from './serve.js';
import { runSessions } from './sessions.js';
import { runSetup } from './setup.js';
import { runTui } from './tui.js';
import { runTrust } from './trust.js';

export interface CommandContext {
  readonly args: readonly string[];
  /** Options, keyed by bare name: `--config` → `flags['config']`. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly stdout: (line: string) => void;
  /** Raw output with no newline appended: `run` streams the model's text through it. */
  readonly write: (text: string) => void;
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
  /**
   * The options this verb accepts (ADR-065 ①). Declared here for the same reason the
   * positional schema is: help text, validation and dispatch all read the table, so an
   * option cannot exist in one and be missing from another.
   */
  readonly flags?: readonly FlagSpec[];
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

const configFlag: FlagSpec = {
  name: '--config',
  value: '<path>',
  summary: '额外的会话层配置（默认只读 user 与 project 两层）',
};
const yesFlag: FlagSpec = {
  name: '--yes',
  summary: '自动放行每一次审批（默认逐条拒绝：这个动词背后没有人可以问）',
};
const sessionFlag: FlagSpec = {
  name: '--session',
  value: '<id>',
  summary: '继续一个已有会话，而不是新建一个',
};
const worktreeFlag: FlagSpec = {
  name: '--worktree',
  value: '<name>',
  summary: '在 .cowcat/worktrees/<name> 的 git worktree 里开会话（复用同名则直接进入；退出时干净树自动清理）',
};
const allFlag: FlagSpec = {
  name: '--all',
  summary: '连子会话一起列出（默认只列顶层会话）',
};
const migrateFlag: FlagSpec = {
  name: '--migrate',
  summary: '把现有 v1 用户配置翻译成 v2（备份原文件，不写密钥）',
};
const presetFlag: FlagSpec = {
  name: '--preset',
  value: '<provider/model>',
  summary: '新建配置时使用的模型 preset（内置 id 见 cowcat setup 的提示）',
};
const apiKeyEnvFlag: FlagSpec = {
  name: '--api-key-env',
  value: '<NAME>',
  summary: '新建配置时写入的密钥环境变量名（只写名字，不读值）',
};
const baseUrlFlag: FlagSpec = {
  name: '--base-url',
  value: '<url>',
  summary: '覆盖 provider 的端点',
};
const forceFlag: FlagSpec = {
  name: '--force',
  summary: '覆盖已有配置（覆盖前会备份）',
};
const printFlag: FlagSpec = {
  name: '--print',
  summary: '只把结果打到 stdout，不写文件',
};
const trustListFlag: FlagSpec = {
  name: '--list',
  summary: '列出已信任的目录',
};
const trustRemoveFlag: FlagSpec = {
  name: '--remove',
  summary: '撤销对该目录的信任',
};

/**
 * The subcommand table is data (ADR-060), for the same reason the protocol's method
 * table is: help text, argument validation and dispatch all read it, so a command
 * cannot be added to one and forgotten in another. Seven verbs, one level, no nesting.
 *
 * Since T4a 3/3 this table lives in `packages/cli` and the wired verbs reach the kernel
 * through `createHost` (ADR-062 ③, ADR-064). `setup` writes the user config directly and
 * never needs a host (ADR-089/090).
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'tui',
    summary: '启动 TUI（无参数时的默认命令）',
    args: noArgs,
    flags: [configFlag, sessionFlag, worktreeFlag],
    usage: 'cowcat [--worktree <name>]',
    status: 'ready',
    run: runTui,
    isDefault: true,
  },
  {
    name: 'serve',
    summary: 'headless 协议服务（stdio，一行一个 JSON）',
    args: noArgs,
    flags: [configFlag],
    usage: 'cowcat serve',
    status: 'ready',
    run: runServe,
  },
  {
    name: 'run',
    summary: '一次性回合（非交互）',
    // The prompt is required; that is the whole argument contract for now.
    args: z.tuple([z.string().min(1)]),
    flags: [configFlag, yesFlag, sessionFlag],
    usage: 'cowcat run "<prompt>"',
    status: 'ready',
    run: runOneShot,
  },
  {
    name: 'doctor',
    summary: '环境、配置、沙箱后端与协议版本逐项检查',
    args: noArgs,
    flags: [configFlag],
    usage: 'cowcat doctor',
    status: 'ready',
    run: runDoctor,
  },
  {
    name: 'sessions',
    summary: '会话管理：list | resume <id>',
    args: z.union([z.tuple([z.literal('list')]), z.tuple([z.literal('resume'), z.string().min(1)])]),
    flags: [configFlag, allFlag],
    usage: 'cowcat sessions list [--all] | resume <id>',
    status: 'ready',
    run: runSessions,
  },
  {
    name: 'setup',
    summary: '写入 v2 用户配置（--migrate 迁移 v1）',
    args: noArgs,
    flags: [migrateFlag, presetFlag, apiKeyEnvFlag, baseUrlFlag, forceFlag, printFlag],
    usage: 'cowcat setup --migrate | --preset <provider/model> [--api-key-env NAME] [--base-url URL] [--force] [--print]',
    status: 'ready',
    run: runSetup,
  },
  {
    name: 'trust',
    summary: '信任一个目录（项目层 allow 与 AGENTS.md 才会生效）',
    args: z.union([z.tuple([]), z.tuple([z.string().min(1)])]),
    flags: [trustListFlag, trustRemoveFlag],
    usage: 'cowcat trust [dir] [--list] [--remove]',
    status: 'ready',
    run: runTrust,
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
