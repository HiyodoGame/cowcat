// Fakes for the P2 ports. They live in support.ts next to the P0/P1 ones so the
// whole set of doubles a test can reach is in one place.
//
// Each fake is deliberately dumb: it answers what it was told, so a test about the
// GATEWAY's behaviour (redaction, truncation, termination order) can assert on the
// spec the gateway built without a real child process in the picture.

import type {
  FileKind,
  FsPort,
  PlatformId,
  PlatformPort,
  ProcessPort,
  ProcessResult,
  ProcessSpec,
  SandboxBackendVerdict,
  Shell,
  TerminationStrategy,
} from '../src/ports/index.js';

/** Records every spec it was handed, and resolves with whatever the test scripted. */
export class RecordingProcess implements ProcessPort {
  readonly specs: ProcessSpec[] = [];
  readonly signals: AbortSignal[] = [];
  readonly #results: readonly ProcessResult[];

  constructor(results: readonly ProcessResult[] = []) {
    this.#results = results;
  }

  async run(spec: ProcessSpec, signal: AbortSignal): Promise<ProcessResult> {
    this.specs.push(spec);
    this.signals.push(signal);
    const next = this.#results[this.specs.length - 1];
    if (next !== undefined) return next;
    return quietResult();
  }
}

/** A run that produced nothing and terminated nothing. The baseline for assertions. */
export function quietResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    // Nothing was dropped and nothing was stripped: the baseline has to be honest
    // about those too, or every test that asserts on them starts from a lie.
    dropped: { stdout: 0, stderr: 0 },
    removedEnv: [],
    ignoredDeny: [],
    termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    ...overrides,
  };
}

/**
 * A filesystem double with a fixed world: `files` and `dirs` are what exists, and
 * `symlinks` maps a spelling to the one it resolves to. Anything unlisted does not
 * exist, which is the property that makes "denied paths are absent" testable.
 */
export function fakeFs(world: {
  readonly files?: readonly string[];
  readonly dirs?: readonly string[];
  readonly symlinks?: Readonly<Record<string, string>>;
} = {}): FsPort {
  const files = new Set(world.files ?? []);
  const dirs = new Set(world.dirs ?? []);
  const symlinks = { ...(world.symlinks ?? {}) };

  const canonical = (path: string): string => {
    let out = path;
    // Collapse `\` and `/` lookups so a test can spell paths either way.
    for (const [alias, target] of Object.entries(symlinks)) {
      if (out === alias) out = target;
      else if (out.startsWith(`${alias}/`)) out = `${target}${out.slice(alias.length)}`;
      else if (out.startsWith(`${alias}\\`)) out = `${target}${out.slice(alias.length)}`;
    }
    return out;
  };

  return {
    canonical,
    samePath: (a, b) => canonical(a) === canonical(b),
    kindOf: (path): FileKind | null => {
      const resolved = canonical(path);
      if (files.has(resolved)) return 'file';
      if (dirs.has(resolved)) return 'directory';
      return null;
    },
    exists: (path) => files.has(canonical(path)) || dirs.has(canonical(path)),
  };
}

/** A platform with a fixed identity, shell, termination strategy and backend verdicts. */
export function fakePlatform(options: {
  readonly platform?: PlatformId;
  readonly shell?: Shell;
  readonly termination?: TerminationStrategy;
  readonly backends?: readonly SandboxBackendVerdict[];
} = {}): PlatformPort {
  const id = options.platform ?? 'linux';
  // Derived from the platform unless overridden, so a fake cannot claim to be Windows
  // and then report a POSIX process group — the mismatch would make every test that
  // used it prove something other than what it says.
  return {
    platform: id,
    resolveShell: () => options.shell ?? (id === 'windows' ? windowsShell() : posixShell()),
    termination: () => options.termination ?? (id === 'windows' ? windowsTermination() : posixTermination()),
    sandboxBackends: () => options.backends ?? [],
  };
}

export function posixShell(executable = '/bin/bash'): Shell {
  return { kind: 'posix', executable, baseArgs: [], commandFlag: '-c' };
}

export function posixTermination(graceMs = 3_000): TerminationStrategy {
  return { kind: 'process-group', graceMs, supportsGraceful: true };
}

export function windowsShell(executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'): Shell {
  return { kind: 'powershell', executable, baseArgs: ['-NoProfile', '-NonInteractive'], commandFlag: '-Command' };
}

export function windowsTermination(): TerminationStrategy {
  // No graceful phase: measured, SIGTERM is not catchable on Windows.
  return { kind: 'taskkill-tree', graceMs: 0, supportsGraceful: false };
}