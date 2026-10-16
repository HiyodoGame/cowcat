// Sandbox policy resolution (system-level Bash sandbox, Phase 1).
//
// Turns `config.sandbox` (a legacy mode string OR the object form that
// src/sandbox.js already accepts) into ONE normalized policy object that the
// backends consume. Keeping resolution in its own module is what lets Phase 4
// swap the backend without touching the product surface: the policy speaks in
// paths/booleans, never in bwrap flags or SBPL rules.
//
// Defaults come from docs/sandbox-system-plan-2026-10-16.md §5.3 and are
// deliberately opinionated:
//   - reads are deny-then-allow with the credential paths denied HARD (a
//     re-allow inside a denied region does not win) — the empirical finding was
//     that a sandboxed read is enough to leak (research §2.5/§2.6);
//   - writes are allow-only, because "anything not granted is denied" is the
//     only shape that does not rot as new paths appear;
//   - network is off.
//
// v1 scope, stated so it cannot be mistaken for more: entries are LITERAL paths
// (absolute, `~`-relative, or relative to the session cwd). Glob patterns are
// collected into `unsupported` and surfaced instead of being silently dropped —
// a policy that pretends to deny `**/.env` while doing nothing is worse than no
// policy at all.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const MODES = ['off', 'light', 'system'];
export const NETWORK_MODES = ['off', 'ask', 'on'];
export const BACKENDS = ['auto', 'bwrap', 'seatbelt', 'none'];

// Credential-shaped locations. Denied for READS even when a broader allow rule
// covers them: this is the whole point of the mode (research §2.5 measured all
// of these as readable inside other agents' sandboxes).
export const DEFAULT_READ_DENY = [
  '~/.ssh',
  '~/.config/gh',
  '~/.git-credentials',
  '~/.cowcat',
  '~/.aws',
  '~/.gnupg',
];

// Home paths toolchains genuinely need. Without these, `git commit` inside the
// sandbox has no identity and npm has no cache: the mode would be switched off
// by users within a day (plan §9 "破坏正常开发" risk).
export const DEFAULT_HOME_READ_ALLOW = ['~/.gitconfig', '~/.npm', '~/.cache'];

export const DEFAULT_WRITE_DENY = ['.env', '.git/hooks'];

export function expandPath(entry, cwd) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const p = entry.trim();
  if (p === '~') return resolve(homedir());
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(join(homedir(), p.slice(2)));
  if (!isAbsolute(p)) return resolve(cwd, p);
  return resolve(p);
}

const isGlob = (entry) => /[*?[\]{}]/.test(String(entry || ''));

function splitEntries(list, cwd, unsupported, label) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (isGlob(raw)) { unsupported.push({ entry: raw, in: label, why: 'glob patterns are not supported in v1' }); continue; }
    const p = expandPath(raw, cwd);
    if (p) out.push(p);
  }
  return out;
}

// Worktrees are created NEXT TO the project (src/worktree.js builds
// `<parent>/<name>-cowcat-<slug>`), so a policy that grants only the session cwd
// makes every worktree session unusable in system mode. Found by reading the
// code, not by guessing: see plan §5.3.
export function worktreeSiblings(cwd) {
  const parent = dirname(cwd);
  const prefix = `${basename(cwd)}-cowcat-`;
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(parent, name))
      .filter((p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

// Accepts 'off' | 'light' | 'system' | { mode, envDeny, read, write, network,
// failOpen, backend }. Anything malformed degrades to the previous behaviour
// (light, no extra policy) rather than throwing into the tool path.
export function normalizeSandbox(config, { cwd = process.cwd() } = {}) {
  const raw = config?.sandbox;
  const obj = raw && typeof raw === 'object' ? raw : {};
  const rawMode = typeof raw === 'string' ? raw : obj.mode;
  const mode = MODES.includes(rawMode) ? rawMode : (rawMode ? 'light' : 'light');

  const envDeny = Array.isArray(config?.sandboxEnvDeny)
    ? config.sandboxEnvDeny
    : (Array.isArray(obj.envDeny) ? obj.envDeny : []);

  const unsupported = [];
  const readDeny = splitEntries(obj.read?.deny ?? DEFAULT_READ_DENY, cwd, unsupported, 'read.deny');
  const readAllow = splitEntries(
    [cwd, ...(obj.read?.allow ?? DEFAULT_HOME_READ_ALLOW)],
    cwd, unsupported, 'read.allow',
  );
  const writeDeny = splitEntries(obj.write?.deny ?? DEFAULT_WRITE_DENY, cwd, unsupported, 'write.deny');
  // NOTE: the host's temp directory is deliberately NOT in the default write set.
  // The backend gives the sandbox a fresh private /tmp instead (see
  // backends/bwrap.js): binding the host's /tmp back in would re-expose every
  // other process's temp files and turn "writes stay in the project" into a
  // half-truth. Measured in CI on the first run of the Linux enforcement tests —
  // the two failing assertions were both caused by exactly this.
  const writeAllow = splitEntries(
    [cwd, ...worktreeSiblings(cwd), ...(obj.write?.allow ?? [])],
    cwd, unsupported, 'write.allow',
  );

  return {
    mode,
    envDeny,
    network: NETWORK_MODES.includes(obj.network) ? obj.network : 'off',
    failOpen: obj.failOpen !== false,
    backend: BACKENDS.includes(obj.backend) ? obj.backend : 'auto',
    // 'workspace' = reads limited to the project + system dirs (default, matches
    // the "a sandboxed read must not leak" invariant); 'hide' = open reads with
    // the denied paths removed (compat escape hatch for toolchains that need an
    // unenumerable path).
    read: { profile: obj.read?.profile === 'hide' ? 'hide' : 'workspace', deny: readDeny, allow: readAllow },
    write: { deny: writeDeny, allow: writeAllow },
    unsupported,
    configured: raw === undefined ? 'light (default)' : JSON.stringify(raw).slice(0, 120),
  };
}

// Human-facing label for logs/audit/UI, e.g. "system (bwrap)".
export function describeSandbox(policy, backend = null) {
  if (policy.mode !== 'system') return policy.mode;
  return backend ? `${policy.mode} (${backend})` : policy.mode;
}
