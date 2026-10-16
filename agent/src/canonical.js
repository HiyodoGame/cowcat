// Path identity, in one place.
//
// WHY THIS EXISTS (macOS, 2026-10-16): on Darwin `/var` is a symlink to
// `/private/var` and `/tmp` to `/private/tmp`, and `os.tmpdir()` hands back the
// symlinked spelling while `process.cwd()` hands back the physical one — the
// kernel's getcwd() never returns a symlink component. So the same directory had
// two identities depending on how you asked for it, and `trust.js` compared
// those identities with `===`:
//
//   trustedProjects: ['/var/folders/xx/…/proj']   (as typed, as os.tmpdir()
//                                                    returns it)
//   process.cwd()  : '/private/var/folders/xx/…/proj'
//   → not equal → the project looked untrusted → the session silently fell back
//     to plan mode. The macOS CI leg caught seven tests failing for this one
//     reason (see docs/fix-plan-2026-10-15.md 第十九轮).
//
// It is not only a trust problem. Seatbelt's `(subpath …)` filters are matched
// against the path the kernel reports, so a policy written as `/var/…` would
// silently fail to grant the very directory it names — the system sandbox would
// refuse to write the project itself.
//
// Therefore: anything used as an IDENTITY (a trust key, a session slug, a
// sandbox allow/deny path) goes through canonicalPath(); anything used merely to
// open a file can keep the caller's spelling.
//
// Two properties this must keep:
//   1. Never throws. A path that cannot be resolved falls back to `resolve()`.
//   2. Never fails on a path that does not exist yet. write.allow entries and
//      worktree siblings are created later, so we canonicalize the deepest
//      EXISTING ancestor and re-append the rest.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

// realpath() is a syscall and canonicalPath() sits on the hot path (every Bash
// call resolves a policy). The same handful of paths repeat forever — the cwd,
// the home dir, the system paths — so a bounded map removes essentially all of
// the calls without ever going stale in a way that matters: a path that changes
// its symlink target mid-process is not a case this program can observe anyway.
const CACHE_LIMIT = 256;
const cache = new Map();

function realpathDeep(p) {
  try {
    return realpathSync.native(p);
  } catch {
    /* fall through: it may not exist yet, or we may lack permission */
  }
  // Walk up to the nearest existing ancestor, canonicalize that, then re-attach
  // the components that did not exist. resolve() first so `..` and relative
  // segments are already collapsed before we start taking dirname().
  const abs = resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return abs; // reached the root without finding anything
    tail.unshift(basename(cur));
    try {
      return resolve(realpathSync.native(parent), ...tail);
    } catch {
      cur = parent;
    }
  }
}

/**
 * The one spelling of a path that means "this directory": symlinks resolved,
 * relative segments collapsed, case as the filesystem reports it.
 *
 * Falls back to `resolve()` when nothing along the chain can be resolved, so it
 * is safe to call on a path that does not exist.
 */
export function canonicalPath(p) {
  if (typeof p !== 'string' || !p) return p;
  const hit = cache.get(p);
  if (hit !== undefined) return hit;
  const out = isAbsolute(p) ? realpathDeep(p) : realpathDeep(resolve(p));
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(p, out);
  return out;
}

/**
 * True when two spellings name the same directory. Used where the QUESTION is
 * identity rather than where a canonical string is needed (trust comparisons):
 * a missing path compares equal to itself, and never throws.
 */
export function samePath(a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    return canonicalPath(a) === canonicalPath(b);
  } catch {
    return false;
  }
}

// Tests must be able to observe a miss, not just a hit.
export function _clearPathCache() {
  cache.clear();
}