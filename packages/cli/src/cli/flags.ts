/**
 * Options, parsed against the table rather than by a library.
 *
 * The rule ADR-060 set for the verbs applies to their options as well: the table is
 * data, so help text, validation and dispatch all read the same declaration. A flag the
 * command did not declare is a usage error — the same statement an unknown verb makes.
 *
 * `--` ends option parsing, so `cowcat run -- --not-an-option` sends the prompt through
 * untouched. A prompt that begins with a dash is otherwise indistinguishable from a
 * misspelled option, and silently treating it as one would run the wrong thing.
 */

export interface FlagSpec {
  /** As typed, with the dashes: `--config`. */
  readonly name: string;
  /** The placeholder for help text when the option takes a value, e.g. `<path>`. */
  readonly value?: string;
  readonly summary: string;
}

export interface ParsedArgv {
  readonly positionals: readonly string[];
  /** Keyed by the bare name: `--config` → `flags['config']`. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** One line per problem; empty means the command line was usable. */
  readonly problems: readonly string[];
}

export function parseArgv(args: readonly string[], spec: readonly FlagSpec[]): ParsedArgv {
  const known = new Map(spec.map((flag) => [flag.name, flag]));
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const problems: string[] = [];
  let literal = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (literal || !arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const flag = known.get(name);
    if (flag === undefined) {
      problems.push(`不认识的选项：${name}`);
      continue;
    }

    if (flag.value === undefined) {
      if (inline !== undefined) {
        problems.push(`${name} 不带值，却写成了 ${name}=${inline}`);
        continue;
      }
      flags[name.replace(/^-+/, '')] = true;
      continue;
    }

    const value = inline ?? args[index + 1];
    // A value that looks like another option is almost always a forgotten value:
    // `--config --yes` would otherwise silently read the config from a file named
    // `--yes`, and the user would get "no such file" instead of "you forgot the path".
    if (value === undefined || value.startsWith('-')) {
      problems.push(`${name} 需要一个值（${flag.value}）`);
      continue;
    }
    if (inline === undefined) index += 1;
    flags[name.replace(/^-+/, '')] = value;
  }

  return { positionals, flags, problems };
}

/** The value of a value-taking option, or `null` when it was not given. */
export function flagValue(flags: Readonly<Record<string, string | boolean>>, name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' ? value : null;
}

/** Whether a boolean option was given. */
export function flagOn(flags: Readonly<Record<string, string | boolean>>, name: string): boolean {
  return flags[name] === true;
}
