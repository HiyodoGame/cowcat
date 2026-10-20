import type { Rule } from '../policy/decide.js';
import type { CowcatConfig, ResolvedMcpSettings } from '../policy/config.js';
import type { McpServerConfig } from '../adapters/mcp/servers.js';
import {
  createConfigFileReader,
  type ConfigFileReader,
  type ConfigFileTarget,
  type ReadTextFile,
} from '../adapters/config-files.js';
import { loadConfig, type ConfigError, type ConfigWarning } from '../adapters/config.js';
import { cowcatPaths, type CowcatPaths } from './paths.js';

// The three config layers, read in order (ADR-025, ADR-063).
//
//   user     ~/.cowcat/config.json          machine-wide, yours
//   project  <cwd>/cowcat.json             the repository's, gated by trust (ADR-028)
//   session  --config <path>                chosen explicitly for this run
//
// What each layer MEANS (merge order, per-entry skip, refusal) is `policy/config.ts` and
// `adapters/config.ts`, and both stay where they are. This file is only the part that
// needs to know about the disk, which is why it is in `src/host/`: which files exist, in
// what order they are read, and — the one judgement it makes — that an unreadable file
// refuses the load instead of being treated as absent.

/**
 * What the composition root adds to the rules every session runs with (ADR-064).
 *
 * `DEFAULT_RULES` deliberately holds one entry and nothing more (ADR-034): the library
 * has no opinion about which tool call should be free of questions, because that is a
 * decision about a working style. The composition root does have one, and it is this:
 * `TodoWrite` writes nothing but the session's own list, and asking about it on every
 * call makes the tool useless (the consequence ADR-054 recorded and left here).
 *
 * It is appended after the config layers, and order does not weaken anything: `decide`
 * picks by category (deny, then ask, then allow), so a `deny` from any layer — including
 * the project's, ADR-028 — still wins. The rule cannot hand out permission for anything
 * but this one tool name.
 */
export const HOST_BASELINE_RULES: readonly Rule[] = [
  {
    name: 'todo-list-is-session-state',
    verdict: 'allow',
    reason: 'TodoWrite only records the session todo list',
    when: { tool: 'TodoWrite' },
  },
];

/** The rules a session runs with: the config's, then the root's own baseline. */
export function withHostRules(rules: readonly Rule[]): readonly Rule[] {
  return [...rules, ...HOST_BASELINE_RULES];
}

/** What a host may start, plus every reason something was left out (ADR-085). */
export interface SelectedMcpServers {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly warnings: readonly string[];
}

/**
 * Applies the trust gate and the credential rule to the merged MCP config.
 *
 * Kept out of `createHost` so both halves are testable without spawning anything: the
 * gate is a policy decision, and the host's job is only to start what comes back.
 */
export function selectMcpServers(mcp: ResolvedMcpSettings, options: { readonly trusted: boolean }): SelectedMcpServers {
  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];
  let untrusted = 0;

  for (const [name, entry] of Object.entries(mcp.servers)) {
    if (entry.origin === 'project' && !options.trusted) {
      untrusted += 1;
      continue;
    }
    let env = entry.settings.env;
    if (entry.origin === 'project' && env !== undefined) {
      // A committed file may say WHAT to run; it may not say which secret comes with it.
      // The entry stays, so the server still starts with the environment the user's own
      // shell already provides.
      warnings.push(`mcp server "${name}" (project layer): env ignored — project config may not supply credentials`);
      env = undefined;
    }
    servers[name] = {
      command: entry.settings.command,
      ...(entry.settings.args === undefined ? {} : { args: entry.settings.args }),
      ...(env === undefined ? {} : { env }),
    };
  }

  if (untrusted > 0) {
    warnings.push(`mcp: skipped ${String(untrusted)} server(s) from the project layer because this workspace is not trusted`);
  }
  return { servers, warnings };
}

export interface HostConfigOptions {
  readonly cwd: string;
  readonly home: string;
  /** The session layer, when the caller named one (`--config <path>`). */
  readonly sessionConfigPath?: string | null;
  /** Overrides the whole layout; the host passes one so a test can point it at a temp dir. */
  readonly paths?: CowcatPaths;
  readonly readFiles?: ConfigFileReader;
  readonly readTextFile?: ReadTextFile;
}

export type HostConfigResult =
  | {
      readonly ok: true;
      readonly config: CowcatConfig;
      readonly warnings: readonly ConfigWarning[];
      /** The files that were read, in layer order. Absent layers are not in here. */
      readonly files: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

export async function loadHostConfig(options: HostConfigOptions): Promise<HostConfigResult> {
  const paths = options.paths ?? cowcatPaths({ cwd: options.cwd, home: options.home });
  const targets: ConfigFileTarget[] = [
    { kind: 'user', path: paths.userConfig },
    { kind: 'project', path: paths.projectConfig },
  ];
  if (options.sessionConfigPath !== undefined && options.sessionConfigPath !== null) {
    targets.push({ kind: 'session', path: options.sessionConfigPath });
  }

  const read = await (options.readFiles ?? createConfigFileReader(options.readTextFile))(targets);
  // A file that is there and cannot be read refuses the load before anything is decoded:
  // starting on the built-in defaults while the user believes their file is in effect is
  // the failure the two tiers of ADR-025 decision 5 exist to separate (that decision is
  // about a bad DOCUMENT; this is its sibling for bytes).
  if (read.errors.length > 0) return { ok: false, errors: read.errors };

  const loaded = loadConfig(read.sources);
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  return { ok: true, config: loaded.config, warnings: loaded.warnings, files: read.sources.map((source) => source.path) };
}
