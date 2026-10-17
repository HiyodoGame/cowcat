// The sandbox executor (P2 T5): given a `system` profile, decide HOW the run is
// wrapped — or refuse it.
//
// This is the only impure part of the sandbox. The builders beside it are pure
// argv/profile functions, so the decision logic here is small enough to read in one
// sitting: pick a backend, refuse what cannot be honoured, create the scratch space
// macOS needs, hand the result to the gateway.
//
// Refusal is the product contract (ADR-016), and there are exactly two kinds:
//
//   * the BACKEND cannot run here        → SandboxUnavailableError   (T4 owns this)
//   * the backend runs but THIS REQUEST cannot be satisfied
//                                      → SandboxRequestRefusedError
//
// Neither ever degrades to `light`. A run that silently loses OS-level isolation
// while the UI says "sandboxed" is the failure this whole file exists to prevent.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SandboxRequestRefusedError,
  SandboxUnavailableError,
  type PlatformPort,
  type ProcessSpec,
  type SandboxBackend,
  type SandboxProfile,
} from '../../ports/index.js';
import { buildBwrapCommand, type BwrapCommand, type SandboxFsProbe } from './backends/bwrap.js';
import { buildSeatbeltCommand } from './backends/seatbelt.js';
import type { SandboxCommand } from '../process.js';

export interface ExecutorDeps {
  readonly platform: PlatformPort;
  readonly fsProbe: SandboxFsProbe;
  /** Injected so tests can drive the scratch directory's lifetime. */
  readonly createScratchDir?: () => string;
  readonly removeScratchDir?: (path: string) => void;
  readonly shell?: string;
}

export function createSandboxExecutor(deps: ExecutorDeps): (spec: ProcessSpec) => SandboxCommand {
  return (spec) => buildSandboxCommand(spec, deps);
}

export function buildSandboxCommand(spec: ProcessSpec, deps: ExecutorDeps): SandboxCommand {
  const profile = spec.sandbox;
  const backend = pickBackend(profile, deps.platform);
  const argv0 = spec.argv[0];
  const command = spec.argv.slice(1);
  if (argv0 === undefined || command.length === 0) {
    throw new Error('a sandboxed run needs a command to wrap');
  }
  // The command goes to the sandbox shell, not to the caller's argv: the gateway is
  // handed an already-quoted command line, and re-quoting it here would be the first
  // place quoting decisions are made twice.
  const commandLine = [argv0, ...command].join(' ');

  refuseUndeliverableNetwork(profile, backend);

  if (backend === 'bwrap') {
    const built: BwrapCommand = buildBwrapCommand(profile, {
      command: commandLine,
      cwd: spec.cwd,
      ...(deps.shell === undefined ? {} : { shell: deps.shell }),
      fs: deps.fsProbe,
      hardening: hardeningFor(deps.platform, 'bwrap'),
    });
    return {
      argv: [built.file, ...built.args],
      backend,
      limitations: [...profile.limitations, ...built.limitations],
    };
  }

  // seatbelt: macOS has no mount namespaces, so there is no way to hand the sandbox a
  // private /tmp the way bubblewrap's tmpfs does. The caller creates an empty
  // directory and TMPDIR points at it instead — every macOS toolchain reads TMPDIR
  // for scratch space, so this is what keeps the host's per-user temp area out.
  const scratch = createScratchDir(deps);
  const built = buildSeatbeltCommand(profile, {
    command: commandLine,
    cwd: spec.cwd,
    ...(deps.shell === undefined ? {} : { shell: deps.shell }),
    tmpDir: scratch,
  });
  return {
    argv: [built.file, ...built.args],
    backend,
    limitations: [...profile.limitations, ...built.limitations],
    env: { TMPDIR: scratch },
    cleanup: () => {
      removeScratchDir(deps, scratch);
    },
  };
}

function pickBackend(profile: SandboxProfile, platform: PlatformPort): SandboxBackend {
  const verdicts = platform.sandboxBackends();

  if (profile.backend !== 'auto') {
    // Naming a backend explicitly means "this one or nothing". Falling back to another
    // would run the command under isolation the user did not ask for, which is as wrong
    // as running it bare — and silently using a backend that CANNOT run is worse still.
    const named = verdicts.find((verdict) => verdict.name === profile.backend);
    if (named === undefined) {
      // No verdict for it at all: either the platform has no such backend, or nothing
      // was probed. Either way it is not available.
      throw new SandboxUnavailableError(
        profile.backend,
        'not-probed',
        `${profile.backend} is not available on ${platform.platform}`,
        [WSL_ALTERNATIVE, LIGHT_ALTERNATIVE],
      );
    }
    if (!named.usable) {
      // The probe's own fix goes first: it is the command that actually solves this
      // machine's problem, and it is verbatim rather than paraphrased.
      const alternatives = named.fix === null ? [WSL_ALTERNATIVE, LIGHT_ALTERNATIVE] : [named.fix, WSL_ALTERNATIVE, LIGHT_ALTERNATIVE];
      throw new SandboxUnavailableError(named.name, named.reason, named.detail, alternatives);
    }
    return named.name;
  }

  const usable = verdicts.find((verdict) => verdict.usable);
  if (usable !== undefined) return usable.name;
  // Nothing usable: report the platform's own reason rather than a paraphrase, so the
  // user reads the fix instructions the probe actually produced.
  const first = verdicts[0];
  const alternatives = first?.fix === null || first?.fix === undefined ? [WSL_ALTERNATIVE, LIGHT_ALTERNATIVE] : [first.fix, WSL_ALTERNATIVE, LIGHT_ALTERNATIVE];
  throw new SandboxUnavailableError(
    first?.name ?? null,
    first?.reason ?? 'no-backend',
    first?.detail ?? `no usable backend for ${platform.platform}`,
    alternatives,
  );
}

/**
 * `network: 'on'` on Seatbelt is refused rather than granted and broken (ADR-016):
 * name resolution does not come back inside the sandbox however much is allowed, and
 * falling back to `light` would drop the filesystem isolation AND keep the network,
 * which is strictly worse than what was asked for.
 */
function refuseUndeliverableNetwork(profile: SandboxProfile, backend: SandboxBackend): void {
  if (backend !== 'seatbelt' || profile.network !== 'on') return;
  throw new SandboxRequestRefusedError(
    'network: on',
    'network-not-supported',
    'name resolution does not work inside a Seatbelt sandbox on macOS, so "on" would grant nothing',
    [
      'use network "off" (the default) or "ask", which grants it per approved command',
      'per-domain egress needs a sandbox-external proxy, which is not built yet',
    ],
  );
}

function hardeningFor(platform: PlatformPort, backend: SandboxBackend): readonly string[] {
  if (backend !== 'bwrap') return [];
  const verdict = platform.sandboxBackends().find((candidate) => candidate.name === 'bwrap');
  return verdict?.hardening ?? [];
}

function createScratchDir(deps: ExecutorDeps): string {
  const create = deps.createScratchDir ?? (() => mkdtempSync(join(tmpdir(), 'cowcat-sandbox-')));
  return create();
}

function removeScratchDir(deps: ExecutorDeps, path: string): void {
  const remove =
    deps.removeScratchDir ??
    ((target: string) => {
      rmSync(target, { recursive: true, force: true });
    });
  remove(path);
}

const WSL_ALTERNATIVE = 'run inside WSL2 — the bubblewrap backend works there';
const LIGHT_ALTERNATIVE = "keep the light tier, whose copy does not claim OS-level isolation (redaction still applies)";