// Path resolution for a sandbox policy (P2 T5).
//
// This lives in policy/ rather than in an adapter because it decides what a policy
// MEANS; the only thing it asks the outside world is "what does this path really
// point at", and that question is asked through FsPort (ADR-017). Nothing here
// touches a process or a backend.
//
// Two rules that are easy to get wrong and that the legacy code got right:
//
//   * Every path leaves here CANONICAL. On macOS `/var` is a symlink to `/private/var`
//     and Seatbelt matches `(subpath …)` against the path the KERNEL reports, so a
//     profile written `/var/...` would grant nothing for `/private/var/...` — the
//     sandbox would refuse to write the project itself.
//   * A glob is COLLECTED, not dropped. A policy that appears to deny `**\/*.env`
//     while doing nothing is worse than no policy at all (research/p2-ports.md §3.1
//     item 9), so the caller is handed the leftovers to surface.

import type { FsPort } from '../ports/index.js';

export interface ResolveRequest {
  readonly entries: readonly string[];
  readonly cwd: string;
  /** Used for `~`. Injected rather than read from `node:os`, so this stays testable. */
  readonly home: string;
  readonly fs: FsPort;
}

export interface ResolveResult {
  /** Absolute, canonical, de-duplicated. Order follows `entries`. */
  readonly resolved: readonly string[];
  /** Entries that were not paths at all (globs), with the reason. Never silently dropped. */
  readonly unsupported: readonly { readonly entry: string; readonly why: string }[];
}

/**
 * Glob detection, kept deliberately narrow: `[`, `]`, `{`, `}` and a bare `*`/`?`.
 * A leading `~` and a Windows drive letter are not globs, and neither is a path that
 * merely contains those characters in a filename — the caller can always narrow this
 * by not writing such names, and a false positive here means a denied path silently
 * becomes no rule at all.
 */
const GLOB = /[*?[\]{}]/;

export function resolveEntries(request: ResolveRequest): ResolveResult {
  const resolved: string[] = [];
  const unsupported: { entry: string; why: string }[] = [];

  for (const raw of request.entries) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const entry = raw.trim();
    if (GLOB.test(entry)) {
      unsupported.push({ entry, why: 'glob patterns are not supported; the backend binds literal paths only' });
      continue;
    }
    // `~name` is another user's home, which we do not expand. Falling through to the
    // relative branch would turn `~root/x` into `<cwd>/~root/x` — a path that looks
    // like a home reference and silently is not one. Report it instead.
    if (entry.startsWith('~') && entry !== '~' && !entry.startsWith('~/') && !entry.startsWith('~\\')) {
      unsupported.push({ entry, why: 'another user\'s home (~user) is not expanded; use an absolute path' });
      continue;
    }
    const expanded = expand(entry, request.home, request.cwd);
    // canonical() never throws and never returns an empty string for a real input, so
    // this is only guarding the impossible — but a '' slipped into write.allow would
    // bind the current directory of the sandbox, which is not a thing to discover at
    // run time.
    const canonical = request.fs.canonical(expanded);
    if (canonical === '' || resolved.includes(canonical)) continue;
    resolved.push(canonical);
  }

  return { resolved, unsupported };
}

/** `~` → home, `~/x` → home/x, relative → against cwd, absolute → itself. */
export function expand(entry: string, home: string, cwd: string): string {
  if (entry === '~') return home;
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    const tail = entry.slice(2);
    return tail === '' ? home : `${home.replace(/[/\\]+$/, '')}/${tail}`;
  }
  // Absolute is decided by the leading separator or a Windows drive letter, not by
  // `node:path`'s isAbsolute: this must behave the same when a Windows path is being
  // resolved in a test that runs on Linux, because the policy layer is portable by
  // design.
  if (isAbsolutePath(entry)) return entry;
  const prefix = cwd.replace(/[/\\]+$/, '');
  return prefix === '' ? entry : `${prefix}/${entry}`;
}

export function isAbsolutePath(entry: string): boolean {
  return entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith('\\\\');
}