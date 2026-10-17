// The Node implementation of FsPort (P2 T3), migrated from agent/src/canonical.js.
//
// WHY THIS FILE IS SMALL BUT LOAD-BEARING: on Darwin `/var` is a symlink to
// `/private/var`, `os.tmpdir()` hands back the symlinked spelling and
// `process.cwd()` hands back the physical one — the kernel's getcwd() never
// returns a symlink component. So the same directory had two identities
// depending on how you asked for it, and `trust.js` compared them with `===`.
// Seven tests failed on the first macOS CI run for that single reason, and the
// sessions silently fell back to plan mode (docs/fix-plan-2026-10-15.md, round 19).
// The same mismatch would make Seatbelt's `(subpath …)` filters fail to grant the
// very directory they name. Hence ADR-017: one implementation, called from
// everywhere a path becomes a key.
//
// Two deliberate departures from the legacy file, both about honesty:
//
//   1. The cache is per-instance, not a module-level Map. A hidden global means
//      two adapters silently share state and no test can get a clean one.
//   2. A result is cached only when some ancestor actually resolved. If the whole
//      chain is unreachable — `Z:\project\file.txt` on a machine with no Z: drive —
//      the answer is the caller's own spelling, and caching it would pin that
//      wrong answer for the life of the session even after the drive appears.
//      The legacy code cached it; that window is the one refinement here.
//
// What is NOT handled, deliberately: a path whose symlink target changes
// mid-session stays cached. That is not observable in practice (a session's cwd,
// home and policy roots do not move), and the escape hatch exists — clearCache() —
// rather than a syscall on every lookup. `test/fs.test.ts` pins the behaviour down
// as a contract instead of leaving it as a claim in a comment.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { FileKind, FsPort } from '../ports/index.js';

// realpath() is a syscall and canonical() sits on the hot path (every Bash call
// resolves a policy). The same handful of paths repeat forever — the cwd, the home
// dir, the system paths — so a bounded map removes essentially all of the calls.
// Cleared wholesale rather than evicted one at a time: at 256 entries a Map with
// true LRU costs bookkeeping on a path we measure in microseconds, and clearing is
// the one eviction policy that can never serve a stale entry after a clear.
const CACHE_LIMIT = 256;

interface Resolved {
  readonly path: string;
  /** Whether some existing ancestor was found; false means "this is just your own spelling". */
  readonly stable: boolean;
}

export class NodeFs implements FsPort {
  readonly #cache = new Map<string, string>();

  canonical(path: string): string {
    // resolve('') is the cwd, so returning early is what keeps an empty path from
    // silently becoming "the current directory" — a wrong answer nobody would notice.
    if (path === '') return '';
    const cached = this.#cache.get(path);
    if (cached !== undefined) return cached;

    // Absolute input goes through the same door as relative: resolve() on an already
    // absolute path is the identity, and it collapses `..` before the walk starts
    // taking dirname(), which is what makes the walk below terminate correctly.
    const resolved = realpathDeep(isAbsolute(path) ? path : resolve(path));
    if (resolved.stable) {
      if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear();
      this.#cache.set(path, resolved.path);
    }
    return resolved.path;
  }

  // Identity, not spelling. No try/catch: canonical() cannot throw (every fs call
  // below is guarded), and swallowing an exception here would hide the day it starts
  // being able to — which is precisely what the contract test is for.
  samePath(a: string, b: string): boolean {
    if (a === b) return true;
    return this.canonical(a) === this.canonical(b);
  }

  // stat, not lstat: a symlink to a directory is a directory as far as a policy is
  // concerned, which is the same reason exists() follows links.
  kindOf(path: string): FileKind | null {
    try {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined) return null;
      if (stat.isDirectory()) return 'directory';
      if (stat.isFile()) return 'file';
      return 'other';
    } catch {
      // EACCES, ELOOP on a symlink cycle, ENOTDIR: "cannot be read" is a fact, not a
      // crash. The sandbox path calls this while deciding what a command may touch.
      return null;
    }
  }

  exists(path: string): boolean {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }

  /** Drop every memoised answer. For callers that mutate the filesystem underneath us. */
  clearCache(): void {
    this.#cache.clear();
  }
}

/**
 * realpath the whole path, or the deepest existing part of it plus the rest.
 *
 * The `resolve()` in the fallback is not cosmetic: `a/../b/c` has to be collapsed
 * before the walk starts taking dirname(), or dirname would hand back a segment
 * that no longer exists and the loop would chase the wrong ancestor.
 */
function realpathDeep(absolute: string): Resolved {
  try {
    return { path: realpathSync.native(absolute), stable: true };
  } catch {
    /* it may not exist yet, or we may lack permission */
  }
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = dirname(current);
    // Reached the root without one realpath succeeding: nothing along this chain is
    // readable, so the caller's own spelling is the only answer available.
    if (parent === current) return { path: absolute, stable: false };
    tail.unshift(basename(current));
    try {
      return { path: resolve(realpathSync.native(parent), ...tail), stable: true };
    } catch {
      current = parent;
    }
  }
}

/** One ready-made port for the composition root. */
export function nodeFs(): FsPort {
  return new NodeFs();
}