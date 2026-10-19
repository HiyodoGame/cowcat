import type { Readable, Writable } from 'node:stream';
import { EXIT } from './exit.js';
import { parseArgv } from './flags.js';
import { renderHelp } from './help.js';
import { COMMANDS, defaultCommand, findCommand, type CommandContext } from './spec.js';
import { readVersion } from './version.js';

export interface CliOptions {
  readonly stdin?: Readable;
  readonly stdoutStream?: Writable;
  readonly stdout?: (line: string) => void;
  /** Raw output, no trailing newline: `run` streams the model's text through it. */
  readonly write?: (text: string) => void;
  readonly stderr?: (line: string) => void;
}

/**
 * The one entry point for every verb (ADR-060): `cowcat`, `cowcat serve`, `cowcat
 * doctor`, and the rest. It returns an exit code instead of writing
 * `process.exitCode` so the whole dispatch is testable in-process.
 *
 * The three exit codes are the contract a script depends on: `0` did what was asked,
 * `2` you typed it wrong, `1` this build cannot do it or it failed. Usage errors are
 * checked before the blocked/execution branch so `cowcat run` (no prompt) reports the
 * missing argument rather than the missing composition root.
 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const stdout =
    options.stdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
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

  // Options before positionals: they are the structural half of the command line, so
  // `cowcat run --nope "x"` should say "unknown option" rather than "wrong number of
  // arguments" — the second message would send someone counting arguments that are fine.
  const parsedArgv = parseArgv(rest, spec.flags ?? []);
  if (parsedArgv.problems.length > 0) {
    for (const problem of parsedArgv.problems) stderr(`cowcat ${spec.name}: ${problem}`);
    stderr(`用法：${spec.usage}`);
    return EXIT.usage;
  }

  const parsed = spec.args.safeParse(parsedArgv.positionals);
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
    flags: parsedArgv.flags,
    stdout,
    write,
    stderr,
    diagnostics: stderr,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdoutStream === undefined ? {} : { stdoutStream: options.stdoutStream }),
  };
  try {
    return await spec.run(context);
  } catch (error) {
    // A last-resort net: every handler is expected to report its own failures (and all of
    // them do), so reaching here means a bug. A stack trace is not something a terminal
    // can use, and exiting non-zero is what a script needs.
    stderr(`cowcat ${spec.name}: 内部错误：${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  }
}
