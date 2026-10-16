// Directory trust (aligned with the reference CLI's trust dialog): an
// interactive session asks before working in an untrusted cwd; declining (or
// non-interactive runs in untrusted dirs) lock the session to read-only plan
// mode. Trusted dirs are persisted in ~/.cowcat/state.json (merged, so
// installId and other state fields survive; legacy config.json copies are
// still honored on read).
import { writeState } from './config.js';
import { canonicalPath, samePath } from './canonical.js';

export function trustedProjects(cfg) {
  return Array.isArray(cfg.trustedProjects) ? cfg.trustedProjects : [];
}

// Identity, not spelling. An exact string comparison looked correct until the
// macOS CI leg showed it is not: on Darwin `/var` is a symlink to `/private/var`,
// so the same project can be written as `/var/folders/…/proj` and come back from
// the kernel as `/private/var/folders/…/proj`. Trusting one spelling did not
// trust the other, and the session silently fell back to plan mode (7 macOS
// test failures, one root cause — docs/fix-plan-2026-10-15.md 第十九轮).
// Both sides are canonicalized so old state files written with either spelling
// keep working without a migration.
export function isTrustedProject(cfg, cwd) {
  return trustedProjects(cfg).some((p) => samePath(p, cwd));
}

// Persist cwd into trustedProjects, preserving every other state field.
// Stored canonical so the key is stable no matter how the directory is reached.
export function trustProject(cfg, cwd) {
  const key = canonicalPath(cwd);
  const next = writeState((state) => {
    const current = Array.isArray(state.trustedProjects) ? state.trustedProjects : [];
    // Dedup by identity, not by text: a legacy state file may already contain
    // the symlinked spelling of the directory we are adding.
    const merged = [...current];
    if (!current.some((p) => samePath(p, key))) merged.push(key);
    state.trustedProjects = Array.from(new Set(merged));
    return state;
  });
  cfg.trustedProjects = next.trustedProjects; // keep the in-memory config in sync
  return next;
}
