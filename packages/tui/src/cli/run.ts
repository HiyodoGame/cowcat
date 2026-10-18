import type { Readable, Writable } from 'node:stream';
import { renderHelp } from './help.js';
import { COMMANDS, defaultCommand, findCommand, type CommandContext } from './spec.js';
import { readVersion } from './version.js';

export const EXIT = {
  ok: 0,
  /** Well-formed invocation, capability missing or execution failed. */
  failed: 1,
  /** The command line itself was wrong (unknown verb, missing argument). */
  usage: 2,
} as const;

export interface CliOptions {
  readonly stdin?: Readable;
  readonly stdoutStream?: Writable;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

/**
 * The one entry point for every verb (ADR-060): `cowcat`, `cowcat serve`, `cowcat
 * doctor`, and the rest. It returns an exit code instead of writing
 * `process.exitCode` so the whole dispatch is testable in-process.
 *
 * The three exit codes are the contract a script depends on: `0` did what was asked,
 * `2` you typed it wrong, `1` this build cannot do it or it failed. Usage errors are
 * checked before the blocked/exectution branch so `cowcat run` (no prompt) reports the
 * missing argument rather than the missing composition root.
 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const stdout =
    options.stdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const stderr =
    options.stderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });

  const [head, ...rest] = argv;
  if (head === '-h' || head === '--help') {
    stdout(renderHelp());
    return EXIT.ok;
  }
  if (head === '-v' || head === '--version') {
    stdout(readVersion());
    return EXIT.ok;
  }

  const spec = head === undefined ? defaultCommand() : findCommand(head);
  if (spec === undefined) {
    stderr(`cowcat: 未知命令 "${head ?? ''}"`);
    stderr(`可用命令：${COMMANDS.map((command) => command.name).join(', ')}`);
    stderr('运行 cowcat --help 看完整说明');
    return EXIT.usage;
  }

  const parsed = spec.args.safeParse(rest);
  if (!parsed.success) {
    stderr(`cowcat ${spec.name}: 参数不对`);
    stderr(`用法：${spec.usage}`);
    return EXIT.usage;
  }

  if (spec.status === 'blocked') {
    stderr(`cowcat ${spec.name}: 尚未接线，需要 ${spec.blockedBy}`);
    return EXIT.failed;
  }

  const context: CommandContext = {
    args: parsed.data,
    stdout,
    stderr,
    diagnostics: stderr,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdoutStream === undefined ? {} : { stdoutStream: options.stdoutStream }),
  };
  return spec.run(context);
}
