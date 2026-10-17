// Sandbox backend probing (P2 T2, the input side of ADR-016).
//
// Ported from the legacy `agent/src/sandbox/probe.js`, keeping what was load-bearing:
//
//   * The probe RUNS the backend. `bwrap` being installed is not the same as bwrap
//     being able to create a user namespace, and `sandbox-exec` existing is not the
//     same as a profile applying.
//   * Failures are CLASSIFIED. "not installed", "user namespaces blocked by AppArmor"
//     (the Ubuntu 23.10+ default) and "something else" need different fixes; a generic
//     "sandbox unavailable" leaves the user with nothing to act on. Every unusable
//     verdict carries a reason, the underlying error's first line, and a
//     copy-pasteable fix when one exists.
//   * A broken probe degrades to "no backend", never to a throw.
//
// `platformId` is a parameter rather than a `process.platform` read, so the whole
// matrix is testable from one machine — the legacy probe did the same, and that is the
// only reason its Linux/macOS/Windows behaviour was ever all covered by one suite.

import type { PlatformId, SandboxBackendVerdict } from '../ports/index.js';
import type { RunResult, ShellRun } from './shell.js';

export interface ProbeHost {
  readonly which: (name: string) => string | null;
  readonly run: ShellRun;
}

const FIX_BWRAP_INSTALL =
  'install it: sudo apt-get install bubblewrap socat (Debian/Ubuntu) or sudo dnf install bubblewrap (Fedora)';

const FIX_USERNS =
  'user namespaces are restricted (Ubuntu 24.04+ AppArmor). Install the profile: ' +
  'sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict ' +
  '&& sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict — or temporarily: ' +
  'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

// bubblewrap's own error text is the only way to tell the failure classes apart: a
// blocked user namespace surfaces as an EPERM-ish message about the uid map or about
// creating the namespace, while a missing binary never gets that far.
const USERNS_BLOCKED = /(uid map|namespace|operation not permitted|permission denied)/i;

export const WINDOWS_ALTERNATIVES: readonly string[] = [
  'run cowcat inside WSL2 — the bubblewrap backend works there',
  'or keep the light tier, which does not claim OS-level isolation',
];

export function probeBackends(platformId: PlatformId, host: ProbeHost): readonly SandboxBackendVerdict[] {
  if (platformId === 'linux' || platformId === 'wsl') return [probeBwrap(host)];
  if (platformId === 'macos') return [probeSeatbelt(host)];
  return [
    {
      name: 'none',
      usable: false,
      reason: 'unsupported-platform',
      detail: platformId,
      fix: platformId === 'windows' ? WINDOWS_ALTERNATIVES.join('. ') : null,
    },
  ];
}

function probeBwrap(host: ProbeHost): SandboxBackendVerdict {
  const path = host.which('bwrap');
  if (path === null) {
    return { name: 'bwrap', usable: false, reason: 'missing', detail: 'bwrap not found on PATH', fix: FIX_BWRAP_INSTALL };
  }
  // The real thing, not a version check: a bwrap that cannot create a user namespace
  // is useless to us, and only running it says so.
  const result = host.run(path, ['--unshare-all', '--ro-bind', '/', '/', 'true']);
  if (result.code === 0) return { name: 'bwrap', usable: true, reason: 'ok', detail: path, fix: null };
  if (USERNS_BLOCKED.test(result.stderr)) {
    return { name: 'bwrap', usable: false, reason: 'userns-blocked', detail: firstLine(result.stderr), fix: FIX_USERNS };
  }
  return { name: 'bwrap', usable: false, reason: 'error', detail: firstLine(result.stderr), fix: null };
}

function probeSeatbelt(host: ProbeHost): SandboxBackendVerdict {
  const path = host.which('sandbox-exec');
  if (path === null) {
    return { name: 'seatbelt', usable: false, reason: 'missing', detail: 'sandbox-exec not found on PATH', fix: null };
  }
  // Permissive profile on purpose: this asks "can a Seatbelt profile be applied at
  // all", not "is this policy correct". Apple's deprecation warning goes to stderr and
  // does not affect the exit code.
  const result = host.run(path, ['-p', '(version 1) (allow default)', '/usr/bin/true']);
  if (result.code === 0) return { name: 'seatbelt', usable: true, reason: 'ok', detail: path, fix: null };
  return { name: 'seatbelt', usable: false, reason: 'error', detail: firstLine(result.stderr), fix: null };
}

// The first non-blank line of a child's error output, or ''. Blank-line skipping matters
// because both bwrap and sandbox-exec can prefix their real message with a warning.
function firstLine(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

/** The backend a run should use: the first usable one, else null. */
export function usableBackend(verdicts: readonly SandboxBackendVerdict[]): SandboxBackendVerdict | null {
  return verdicts.find((verdict) => verdict.usable) ?? null;
}

export type { RunResult };