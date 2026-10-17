// Shell resolution (P2 T2). The decision and its evidence live in
// docs/research/p2-shell-detection.md; this file is the implementation.
//
// Three findings from that research shape everything here:
//
//  1. A bare name is never a candidate. On this project's reference machine `bash` on
//     PATH is the WSL launcher (exits 1, the distro has no bash) and, after it, an
//     OpenSSH shim that RUNS but is the wrong tool (`$0=sh`, cygwin PATH). Everything
//     is spawned by ABSOLUTE path, which also removes the cwd-shadowing path
//     (a real `bash.exe` in the cwd beats System32 — measured).
//  2. Discovery has to follow the actual installation. Neither the registry nor
//     `C:\Program Files\Git` was present on that machine; "look next to git.exe" was
//     the only source that worked. Roots are found by walking UP from every resolved
//     git path until a bash shows up, which covers both `<root>\cmd\git.exe` and the
//     `<root>\mingw64\bin\git.exe` you get when the query runs from inside Git Bash.
//  3. "It runs" is not "it is the shell we want", so a candidate is accepted only if it
//     runs AND echoes the marker — the marker check is per-kind, because OpenSSH's
//     shim passes a naive existence test.
//
// Every host-dependent operation (which, exists, spawn) is injected, so the chain and
// the acceptance rules are testable without a machine that happens to have Git in a
// particular place.
//
// Synchronous on purpose: the shell is resolved once per session, before any command
// runs, and a blocking probe there costs less than the ceremony an async contract would
// add to every caller (same reasoning as FsPort staying sync, ADR-017).

import type { PlatformId, Shell, ShellKind } from '../ports/index.js';

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Never throws: a candidate that cannot be started is a data point, not a failure. */
export type ShellRun = (exe: string, args: readonly string[]) => RunResult;

export interface ShellHost {
  /** PATH lookup returning an ABSOLUTE path, or null. Never spawns anything. */
  readonly which: (name: string) => string | null;
  readonly exists: (path: string) => boolean;
  readonly run: ShellRun;
}

export interface PathFlavour {
  readonly join: (...parts: string[]) => string;
  readonly dirname: (path: string) => string;
  readonly separator: string;
}

export interface ShellCandidate {
  readonly kind: ShellKind;
  readonly executable: string;
  readonly baseArgs: readonly string[];
  readonly commandFlag: string;
  /** What "this candidate works" looks like when executed. */
  readonly verifyArgs: readonly string[];
  readonly marker: string;
}

const MARKER = 'COWCAT_SHELL_OK';

// ── platform identity ────────────────────────────────────────────────────────────

/**
 * WSL is reported separately from Linux even though bubblewrap works inside it: the
 * fix instructions are distro-side, so telling a WSL user to install a Debian package
 * from the Windows side wastes their time.
 */
export function detectPlatformId(env: Readonly<Record<string, string | undefined>>, platform: string): PlatformId {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') {
    const wsl = env['WSL_DISTRO_NAME'] ?? env['WSL_INTEROP'] ?? env['WSLENV'];
    return wsl !== undefined && wsl !== '' ? 'wsl' : 'linux';
  }
  return 'other';
}

// ── candidate construction ───────────────────────────────────────────────────────

/**
 * Installation roots for Git for Windows, found by walking up from every path `git`
 * resolves to. Depth is bounded: `<root>\cmd\git.exe` is one level down and
 * `<root>\mingw64\bin\git.exe` two; anything deeper is a different toolchain.
 */
export function gitRoots(
  gitPaths: readonly string[],
  exists: (path: string) => boolean,
  path: PathFlavour,
  maxDepth = 4,
): readonly string[] {
  const roots: string[] = [];
  for (const start of gitPaths) {
    let dir = path.dirname(start);
    for (let depth = 0; depth < maxDepth; depth += 1) {
      // `bin\bash.exe` is the Git Bash entry point (it puts /mingw64/bin first);
      // `usr\bin\bash.exe` is the raw MSYS bash, kept as the weaker second choice.
      if (exists(path.join(dir, 'bin', 'bash.exe')) || exists(path.join(dir, 'usr', 'bin', 'bash.exe'))) {
        if (!roots.includes(dir)) roots.push(dir);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return roots;
}

export function windowsShellCandidates(
  host: ShellHost,
  path: PathFlavour,
  installRoots: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): readonly ShellCandidate[] {
  const candidates: ShellCandidate[] = [];

  // 1. Git Bash, discovered from the actual installation. `bin` before `usr\bin`:
  //    they both run, but only `bin` gives the mingw64-first PATH that Git Bash users
  //    (and therefore the commands the model writes) expect.
  for (const root of installRoots) {
    candidates.push(bashCandidate(path.join(root, 'bin', 'bash.exe')));
    candidates.push(bashCandidate(path.join(root, 'usr', 'bin', 'bash.exe')));
  }

  // 2. PowerShell 7 before 5.1: it starts several times faster, and 5.1 costs every
  //    single command ~745ms (measured) because the shell is spawned per command.
  const pwsh = host.which('pwsh');
  if (pwsh !== null) candidates.push(powershellCandidate(pwsh));
  const windowsPowerShell = host.which('powershell');
  if (windowsPowerShell !== null) candidates.push(powershellCandidate(windowsPowerShell));

  // 3. cmd.exe last. It is always there and it is fast, but its semantics differ
  //    enough that it must not be mistaken for a POSIX shell. ComSpec rather than a
  //    guessed `C:\Windows\System32\cmd.exe`: on a non-standard install it points
  //    somewhere else.
  const comSpec = env['ComSpec'];
  if (comSpec !== undefined && comSpec !== '') {
    candidates.push({
      kind: 'cmd',
      executable: comSpec,
      baseArgs: ['/d'],
      commandFlag: '/s /c',
      verifyArgs: ['/d', '/s', '/c', `echo ${MARKER}`],
      marker: MARKER,
    });
  }

  return candidates;
}

/**
 * POSIX: /bin/bash first, then the user's own $SHELL, then /bin/sh.
 *
 * NOT verified on macOS (docs/research/p2-shell-detection.md §3): macOS has /bin/bash
 * 3.2 while the default shell is /bin/zsh, and this order deliberately picks bash
 * because the sandbox profiles hardcode /bin/bash — a different interpreter inside
 * and outside the sandbox turns "works out here, fails in there" into a much harder
 * bug. That choice needs a real macOS run before it is trusted.
 */
export function posixShellCandidates(
  host: ShellHost,
  env: Readonly<Record<string, string | undefined>>,
  installRoots: readonly string[] = [],
): readonly ShellCandidate[] {
  const candidates: ShellCandidate[] = [];
  const push = (candidate: ShellCandidate | null): void => {
    if (candidate !== null && !candidates.some((c) => c.executable === candidate.executable)) {
      candidates.push(candidate);
    }
  };
  push(host.exists('/bin/bash') ? bashCandidate('/bin/bash') : null);
  const shell = env['SHELL'];
  if (shell !== undefined && shell !== '') push(bashCandidate(shell));
  push(host.exists('/bin/sh') ? bashCandidate('/bin/sh') : null);
  for (const root of installRoots) push(bashCandidate(`${root}/bin/bash`));
  return candidates;
}

function bashCandidate(executable: string): ShellCandidate {
  return {
    kind: 'posix',
    executable,
    baseArgs: [],
    commandFlag: '-c',
    verifyArgs: ['-c', `printf %s ${MARKER}`],
    marker: MARKER,
  };
}

function powershellCandidate(executable: string): ShellCandidate {
  return {
    kind: 'powershell',
    executable,
    baseArgs: ['-NoProfile', '-NonInteractive'],
    commandFlag: '-Command',
    verifyArgs: ['-NoProfile', '-NonInteractive', '-Command', `Write-Output '${MARKER}'`],
    marker: MARKER,
  };
}

/** Git Bash is bash with an MSYS environment; the distinction matters when reporting. */
function kindOf(candidate: ShellCandidate, installRoots: readonly string[]): ShellKind {
  if (candidate.kind !== 'posix') return candidate.kind;
  const insideAnInstallRoot = installRoots.some(
    (root) => candidate.executable.startsWith(`${root}${WIN_SEPARATOR}`) || candidate.executable.startsWith(`${root}/`),
  );
  return insideAnInstallRoot ? 'git-bash' : 'posix';
}

const WIN_SEPARATOR = '\\';

// ── resolution ───────────────────────────────────────────────────────────────────

export interface ShellResolution {
  readonly shell: Shell;
  /** Every candidate that was tried and why it lost. Diagnostics, not noise. */
  readonly attempts: readonly { readonly executable: string; readonly outcome: 'selected' | 'absent' | 'failed' }[];
}

export interface ResolveOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly installRoots?: readonly string[];
  readonly path: PathFlavour;
}

/**
 * Resolve the shell, once per session.
 *
 * Each candidate is EXECUTED before it is accepted. `exists` is not enough (the OpenSSH
 * shim exists and runs) and neither is a version check (it is a different shell). The
 * first candidate that runs and echoes the marker wins; if none does, this throws
 * rather than silently settling for cmd, because "your shell is not what you think it
 * is" deserves an error message.
 */
export function resolveShell(platformId: PlatformId, host: ShellHost, options: ResolveOptions): ShellResolution {
  const env = options.env ?? {};
  const roots = options.installRoots ?? (platformId === 'windows' ? discoverWindowsRoots(host, options.path) : []);
  const candidates =
    platformId === 'windows'
      ? windowsShellCandidates(host, options.path, roots, env)
      : posixShellCandidates(host, env, roots);

  const attempts: { executable: string; outcome: 'selected' | 'absent' | 'failed' }[] = [];

  for (const candidate of candidates) {
    if (!host.exists(candidate.executable)) {
      attempts.push({ executable: candidate.executable, outcome: 'absent' });
      continue;
    }
    const result = host.run(candidate.executable, candidate.verifyArgs);
    if (result.code === 0 && result.stdout.includes(candidate.marker)) {
      attempts.push({ executable: candidate.executable, outcome: 'selected' });
      return {
        shell: {
          kind: platformId === 'windows' ? kindOf(candidate, roots) : candidate.kind,
          executable: candidate.executable,
          baseArgs: candidate.baseArgs,
          commandFlag: candidate.commandFlag,
        },
        attempts,
      };
    }
    attempts.push({ executable: candidate.executable, outcome: 'failed' });
  }

  const tried = attempts.map((attempt) => `${attempt.executable} (${attempt.outcome})`).join(', ');
  throw new Error(
    `no usable shell found for ${platformId}; tried ${tried === '' ? '(no candidates)' : tried}. ` +
      'Install Git for Windows or a POSIX shell, or set one explicitly.',
  );
}

/**
 * Windows installation roots: next to a real git.exe first, then whatever extra roots
 * the caller supplies (registry entries and well-known locations). Those extras were
 * both ABSENT on the reference machine, which is why they are supplements rather than
 * the main road.
 */
export function discoverWindowsRoots(
  host: ShellHost,
  path: PathFlavour,
  extraRoots: readonly string[] = [],
): readonly string[] {
  const gitPath = host.which('git');
  const fromGit = gitPath === null ? [] : gitRoots([gitPath], host.exists, path);
  return [...new Set([...fromGit, ...extraRoots])];
}

// Small local path helpers so this module stays pure and the caller injects the
// flavour (win32 vs posix) it actually needs — the same trick the legacy bwrap builder
// used for its filesystem probes.
export const winPath: PathFlavour = {
  join: (...parts) => parts.filter((p) => p !== '').join(WIN_SEPARATOR),
  dirname: (path) => {
    const index = Math.max(path.lastIndexOf(WIN_SEPARATOR), path.lastIndexOf('/'));
    return index <= 0 ? path : path.slice(0, index);
  },
  separator: ';',
};

export const posixPath: PathFlavour = {
  join: (...parts) => parts.filter((p) => p !== '').join('/'),
  dirname: (path) => {
    const index = path.lastIndexOf('/');
    return index <= 0 ? path : path.slice(0, index);
  },
  separator: ':',
};