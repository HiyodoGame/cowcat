// System-level Bash sandbox preflight (Phase 0).
//
// This module answers exactly ONE question: on this machine, right now, which
// OS-level sandbox backend can we rely on — and if none, why? It deliberately
// changes nothing about how commands run; Phase 1 wires the answer into the
// Bash tool as the optional `sandbox: 'system'` mode. Keeping detection separate
// means doctor, `/sandbox` and (later) the Bash path share one cached verdict
// instead of each inventing its own.
//
// The classification matters as much as the boolean. "bwrap is not installed",
// "user namespaces are blocked by AppArmor" (the Ubuntu 23.10+ default) and
// "the kernel is too old for the feature we need" (RHEL 9's 5.14) need three
// different fixes, and a generic "sandbox unavailable" leaves the user with
// nothing to act on. Each verdict therefore carries a `reason`, the first line
// of the underlying error, and a copy-pasteable `fix` when one exists.
//
// Never throws. A broken probe degrades to "no backend", the same way a broken
// sandbox degrades to light mode (see the threat model in src/sandbox.js).
//
// Design decisions live in docs/sandbox-system-plan-2026-10-16.md §4; the
// environment quirks referenced below are catalogued in
// docs/sandbox-research-2026-10-16.md §7.

import { execFileSync } from 'node:child_process';

// WSL counts as Linux for capability purposes (bubblewrap works inside it), but
// it is reported separately because the fix instructions differ (the package is
// installed in the distro, not in Windows).
export function detectPlatform(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') {
    const wsl = env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV;
    return wsl ? 'wsl' : 'linux';
  }
  return 'other';
}

// `command -v` over `which`: the former is a shell builtin on every POSIX shell
// we support, while `which` is a separate (sometimes absent) binary.
function defaultWhich(bin) {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${bin}`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function defaultRun(file, args) {
  try {
    execFileSync(file, args, {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stderr: '' };
  } catch (e) {
    const stderr = typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e?.message ?? e);
    return { ok: false, stderr };
  }
}

const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';

// bubblewrap's own error text is the only way to tell the failure classes apart:
// a blocked user namespace surfaces as an EPERM-ish message about the uid map or
// about creating the namespace, while a missing binary never gets that far.
const USERNS_BLOCKED = /(uid map|namespace|operation not permitted|permission denied)/i;

const FIX_BWRAP_INSTALL = 'install it: sudo apt-get install bubblewrap socat (Debian/Ubuntu) or sudo dnf install bubblewrap (Fedora)';
const FIX_USERNS = 'user namespaces are restricted (Ubuntu 24.04+ AppArmor). Install the profile: sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict — or temporarily: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

function probeBwrap(which, run) {
  const path = which('bwrap');
  if (!path) {
    return { name: 'bwrap', usable: false, reason: 'missing', detail: 'bwrap not found on PATH', fix: FIX_BWRAP_INSTALL };
  }
  // The probe is the real thing, not a version check: a `bwrap` binary that
  // cannot create a user namespace is useless to us, and only running it says so.
  const res = run(path, ['--unshare-all', '--ro-bind', '/', '/', 'true']);
  if (res.ok) return { name: 'bwrap', usable: true, reason: 'ok', detail: path, fix: null };
  const line = firstLine(res.stderr);
  if (USERNS_BLOCKED.test(res.stderr)) {
    return { name: 'bwrap', usable: false, reason: 'userns-blocked', detail: line, fix: FIX_USERNS };
  }
  return { name: 'bwrap', usable: false, reason: 'error', detail: line, fix: null };
}

function probeSeatbelt(which, run) {
  const path = which('sandbox-exec');
  if (!path) {
    return { name: 'seatbelt', usable: false, reason: 'missing', detail: 'sandbox-exec not found on PATH', fix: null };
  }
  // Permissive profile on purpose: this asks "can we apply a Seatbelt profile at
  // all", not "is this particular policy correct". The deprecation warning Apple
  // prints goes to stderr and does not affect the exit code.
  const res = run(path, ['-p', '(version 1) (allow default)', '/usr/bin/true']);
  if (res.ok) return { name: 'seatbelt', usable: true, reason: 'ok', detail: path, fix: null };
  return { name: 'seatbelt', usable: false, reason: 'error', detail: firstLine(res.stderr), fix: null };
}

const WINDOWS_FIX = 'run cowcat inside WSL2 (the bubblewrap backend works there), or inside Docker Sandboxes: sbx run <agent>';
const PLATFORM_NOTES = {
  win32: ['native Windows has no single primitive that sandboxes a coding agent cleanly (plan §4.3) — v1 does not attempt it'],
  wsl: ['bubblewrap runs inside the distro; install it there, not on the Windows side'],
  other: ['unsupported platform for the system-level backend'],
};

export function probeBackends({ platform = detectPlatform(), which = defaultWhich, run = defaultRun } = {}) {
  let backends;
  if (platform === 'linux' || platform === 'wsl') backends = [probeBwrap(which, run)];
  else if (platform === 'darwin') backends = [probeSeatbelt(which, run)];
  else {
    backends = [{
      name: 'none', usable: false, reason: 'unsupported-platform',
      detail: platform, fix: platform === 'win32' ? WINDOWS_FIX : null,
    }];
  }
  const usable = backends.find((b) => b.usable) || null;
  return {
    platform,
    usable: usable ? usable.name : null,
    backends,
    notes: PLATFORM_NOTES[platform] || [],
  };
}

// Memoized verdict for hot paths (doctor, /sandbox, and later every Bash call).
// The answer only changes when the OS or the installed binaries do, both of
// which require a restart to take effect anyway.
let cached = null;
export function sandboxProbe({ force = false } = {}) {
  if (!cached || force) cached = probeBackends();
  return cached;
}

export function formatSandboxProbe(probe) {
  const lines = [`platform: ${probe.platform}`];
  for (const b of probe.backends) {
    lines.push(b.usable
      ? `backend: ${b.name} — usable (${b.detail})`
      : `backend: ${b.name} — unavailable [${b.reason}]${b.detail ? `: ${b.detail}` : ''}`);
    if (!b.usable && b.fix) lines.push(`  fix: ${b.fix}`);
  }
  for (const n of probe.notes) lines.push(`note: ${n}`);
  return lines;
}

// One-line summary for places that only have room for a phrase (status bars,
// the Bash card badge in Phase 1).
export function sandboxProbeSummary(probe = sandboxProbe()) {
  if (probe.usable) return `system sandbox available (${probe.usable})`;
  const first = probe.backends[0];
  return `system sandbox unavailable (${first?.reason || 'unknown'})`;
}
