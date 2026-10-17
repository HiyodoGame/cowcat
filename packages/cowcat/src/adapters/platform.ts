// The Node implementation of PlatformPort (P2 T2).
//
// Everything the kernel, the policy layer and the tool layer are forbidden from knowing
// about the host is answered here: which platform this is, which shell commands run
// through, how a process tree gets terminated, and which sandbox backends actually work.
//
// Both probes are resolved ONCE per session. That is not laziness: the PowerShell 5.1
// fallback costs ~745ms to start (measured), and the sandbox probe spawns processes, so
// a per-command probe would show up in every tool call's latency. Nothing about the
// answer changes within a session, and if the user installs something mid-session, the
// next session picks it up.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type {
  PlatformId,
  PlatformPort,
  SandboxBackendVerdict,
  Shell,
  TerminationStrategy,
} from '../ports/index.js';
import { probeBackends } from './sandbox-probe.js';
import {
  detectPlatformId,
  discoverWindowsRoots,
  posixPath,
  resolveShell,
  winPath,
  type PathFlavour,
  type RunResult,
  type ShellHost,
  type ShellResolution,
} from './shell.js';

// How long a probe may take before it is treated as a failed candidate. Generous
// enough for a cold Windows Defender scan of a 300KB binary, short enough that a
// wedged candidate cannot hang session startup.
const PROBE_TIMEOUT_MS = 8_000;

export interface NodePlatformOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  /** Injected for tests; defaults to the real host. */
  readonly which?: (name: string) => string | null;
  readonly exists?: (path: string) => boolean;
  readonly run?: (exe: string, args: readonly string[]) => RunResult;
}

export class NodePlatform implements PlatformPort {
  readonly platform: PlatformId;
  readonly #path: PathFlavour;
  readonly #host: ShellHost;
  readonly #env: Readonly<Record<string, string | undefined>>;
  #shell: ShellResolution | null = null;
  #backends: readonly SandboxBackendVerdict[] | null = null;

  constructor(options: NodePlatformOptions = {}) {
    const env = options.env ?? process.env;
    const nodePlatform = options.platform ?? process.platform;
    this.platform = detectPlatformId(env, nodePlatform);
    this.#path = this.platform === 'windows' ? winPath : posixPath;
    this.#env = env;
    this.#host = {
      which: options.which ?? whichOnPath,
      exists: options.exists ?? existsSync,
      run: options.run ?? runSync,
    };
  }

  /**
   * Git Bash first, then PowerShell, then cmd. The evidence for that order — including
   * why a bare `bash` is never a candidate and why `bin\bash.exe` beats
   * `usr\bin\bash.exe` — is in docs/research/p2-shell-detection.md.
   *
   * Memoised because the answer cannot change inside a session, and because finding it
   * can cost a PowerShell start.
   */
  resolveShell(): Shell {
    if (this.#shell === null) {
      const roots =
        this.platform === 'windows'
          ? discoverWindowsRoots(this.#host, this.#path, [...registryInstallPaths(), 'C:\\Program Files\\Git'])
          : [];
      this.#shell = resolveShell(this.platform, this.#host, {
        path: this.#path,
        env: this.#env,
        installRoots: roots,
      });
    }
    return this.#shell.shell;
  }

  /** How a whole process tree is killed here, and whether a graceful phase exists. */
  termination(): TerminationStrategy {
    if (this.platform === 'windows') {
      // Measured: SIGTERM is not catchable on Windows, so there is no graceful phase to
      // escalate from — `/F` is the only semantics available (ADR-014).
      return { kind: 'taskkill-tree', graceMs: 0, supportsGraceful: false };
    }
    return { kind: 'process-group', graceMs: 3_000, supportsGraceful: true };
  }

  sandboxBackends(): readonly SandboxBackendVerdict[] {
    this.#backends ??= probeBackends(this.platform, this.#host);
    return this.#backends;
  }

  /** Diagnostics: every candidate tried while resolving the shell. */
  shellAttempts(): readonly { readonly executable: string; readonly outcome: 'selected' | 'absent' | 'failed' }[] {
    this.resolveShell();
    return this.#shell?.attempts ?? [];
  }
}

// ── host operations ──────────────────────────────────────────────────────────────

/**
 * PATH lookup by ABSOLUTE result. Windows gets `where.exe` (the built-in one, not a
 * Git-provided `where` that would itself need Git); POSIX gets `command -v` inside `sh`,
 * because `which` is a separate binary that may not be installed.
 */
function whichOnPath(name: string): string | null {
  try {
    const result =
      process.platform === 'win32'
        ? execFileSync('where.exe', [name], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
        : execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = result.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Spawn without a shell, always. `shell: true` is not an option here: it re-quotes the
 * command string, it makes Node refuse to run `.cmd` shims without a second hop, and it
 * hands the cwd a chance to shadow whatever we meant to run (measured: a `bash.cmd` in the
 * project directory wins over the real shell).
 */
function runSync(exe: string, args: readonly string[]): RunResult {
  const result = spawnSync(exe, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  return { code: result.status, stdout: text(result.stdout), stderr: text(result.stderr) };
}

/**
 * `spawnSync` is typed as always producing a string here, but a process that could not be
 * started at all reports null. Taking `unknown` keeps that honest without a cast or a
 * `String()` the linter can rightly call pointless.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Git for Windows installs here when the user has one. A SUPPLEMENT, not the main road:
 * on the reference machine all three registry views were absent AND the default path was
 * absent (Git lived on E:), so "next to git.exe" is what actually resolved it.
 */
function registryInstallPaths(): readonly string[] {
  if (process.platform !== 'win32') return [];
  const found: string[] = [];
  for (const key of ['HKLM\\SOFTWARE\\Git', 'HKLM\\SOFTWARE\\WOW6432Node\\Git', 'HKCU\\SOFTWARE\\Git']) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'InstallPath'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /InstallPath\s+REG_\w+\s+(.+)/.exec(out);
      if (match?.[1] !== undefined) found.push(match[1].trim());
    } catch {
      // Key absent on most non-default installs; the next source gets its turn.
    }
  }
  return found;
}

/** One ready-made port for the composition root. */
export function nodePlatform(options: NodePlatformOptions = {}): PlatformPort {
  return new NodePlatform(options);
}