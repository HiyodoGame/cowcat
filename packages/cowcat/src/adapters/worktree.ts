// Worktree lifecycle for the CLI's `--worktree` flow (ADR-144/145/147).
//
// Every process here goes through ProcessPort (ADR-014) with the sandbox off: this is a
// host-initiated action the user asked for with a flag, not a model call — the same
// status hooks have when they spawn. Creating inside a sandbox would fail anyway (a
// worktree writes the shared `.git`).
//
// Trust is inherited at CREATION, not derived at runtime (ADR-145): the main checkout
// must be trusted before the worktree is created, and the worktree's canonical path is
// then written into the same trust record `cowcat trust` maintains — auditable, and
// revocable by deleting that one line. Reusing an existing worktree does NOT re-add the
// record: trust is a statement about a directory, and if the user revoked it, a new
// session there must run untrusted (ADR-028's snapshot rule, applied to the reuse path).

import { normalize } from 'node:path';
import { isTrusted } from '../policy/trust.js';
import type { FsPort, ProcessPort, TrustSnapshot } from '../ports/index.js';

/** One directory per name, under `.cowcat/worktrees/`, on a branch `worktree-<name>`. */
const WORKTREES_DIR = '.cowcat/worktrees';
const BRANCH_PREFIX = 'worktree-';

/** Names are a filename and a branch suffix: this is the whole safe charset. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface WorktreeInfo {
  /** Absolute path of the worktree checkout — the session cwd. */
  readonly path: string;
  /** The branch the worktree is on (`worktree-<name>`). */
  readonly branch: string;
  /** True when git created it just now; false when an existing one was reused. */
  readonly created: boolean;
  /** Absolute git dir of the MAIN checkout — sessions need it in their write allow. */
  readonly mainGitDir: string;
}

export type EnsureWorktreeResult = { readonly ok: true; readonly worktree: WorktreeInfo } | { readonly ok: false; readonly error: string };

export interface WorktreeDeps {
  readonly process: ProcessPort;
  readonly fs: FsPort;
  /** The same store `cowcat trust` reads and writes — inheritance uses no other record. */
  readonly trust: {
    load(): Promise<TrustSnapshot>;
    add(path: string): Promise<void>;
  };
  /** Where the user ran the command: the main checkout the worktree belongs to. */
  readonly mainCwd: string;
}

function joinPath(base: string, ...segments: readonly string[]): string {
  const tail = segments.join('/');
  return base.replace(/[/\\]+$/, '') + '/' + tail;
}

/** A run with the sandbox off: these are host actions, and the sandbox would refuse them. */
async function git(deps: WorktreeDeps, argv: readonly string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await deps.process.run(
    {
      argv: ['git', ...argv],
      cwd,
      env: {},
      sandbox: {
        mode: 'off',
        backend: 'none',
        network: 'off',
        env: { deny: [] },
        read: { profile: 'workspace', allow: [], deny: [] },
        write: { allow: [], deny: [] },
        limitations: [],
      },
    },
    new AbortController().signal,
  );
  return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * Create the named worktree from the main checkout's HEAD, or adopt it when the name
 * already exists. Refuses — without touching anything — when the main checkout is not a
 * git repository, is not trusted, or the worktrees directory is reached through a link.
 */
export async function ensureWorktree(deps: WorktreeDeps, name: string): Promise<EnsureWorktreeResult> {
  if (!NAME.test(name)) {
    return { ok: false, error: `invalid worktree name "${name}": use letters, digits, '-' and '_' (1-64 chars)` };
  }
  const main = deps.fs.canonical(deps.mainCwd);
  if (main === '') return { ok: false, error: `cannot resolve the main checkout path: ${deps.mainCwd}` };
  // `canonical` returns the platform's spelling; path assembly below uses it verbatim.

  const trust = await deps.trust.load();
  if (trust.problem !== null) {
    return { ok: false, error: `cannot read the trust record: ${trust.problem}` };
  }
  if (!isTrusted(trust.trusted, main, deps.fs)) {
    return {
      ok: false,
      error: `the main checkout is not trusted, so CowCat will not create a worktree session in it (ADR-145); run "cowcat trust" in ${main} first`,
    };
  }

  const inside = await git(deps, ['rev-parse', '--is-inside-work-tree'], main);
  if (!inside.ok || inside.stdout !== 'true') {
    return { ok: false, error: `${main} is not a git work tree; git worktrees need a repository` };
  }

  const root = joinPath(main, WORKTREES_DIR);
  const path = joinPath(root, name);
  const branch = BRANCH_PREFIX + name;

  // A link in the path is refused, not followed (the upstream caution, ADR-144 ③).
  // `canonical` re-spells missing tails in the platform's separator, so the comparison
  // runs against the normalized spelling; anything else means a link (or a
  // case-variant directory) was resolved somewhere along the path.
  const resolved = deps.fs.canonical(path);
  const spelled = normalize(path);
  if (resolved === '') {
    return { ok: false, error: `cannot resolve the worktree path: ${path}` };
  }
  if (resolved !== spelled) {
    return { ok: false, error: `refusing to use "${path}": it resolves to "${resolved}" through a link` };
  }

  if (deps.fs.exists(path)) {
    // Reuse does not re-add the trust record (ADR-145: a revoked record stays revoked).
    // We also do not verify the directory is a checkout of THIS repository on the assumed
    // branch: cleanup walks git itself, and any mismatch lands on the kept-* safe side.
    const gitDir = await mainGitDir(deps, main);
    if (gitDir === null) return { ok: false, error: `cannot resolve the main checkout's git dir in ${main}` };
    return { ok: true, worktree: { path: spelled, branch, created: false, mainGitDir: gitDir } };
  }

  // The main checkout's git dir is needed by the SESSION (ADR-147), not by the add:
  // resolve it BEFORE creating anything, so a failure here leaves nothing behind.
  const gitDir = await mainGitDir(deps, main);
  if (gitDir === null) return { ok: false, error: `cannot resolve the main checkout's git dir in ${main}` };

  const add = await git(deps, ['worktree', 'add', path, '-b', branch], main);
  let created = add.ok;
  if (!add.ok) {
    // The branch surviving from an earlier create whose directory was deleted: adopt it
    // instead of failing on `-b`.
    const ref = await git(deps, ['show-ref', '--verify', `refs/heads/${branch}`], main);
    if (!ref.ok) return { ok: false, error: `git worktree add failed: ${add.stderr || add.stdout}` };
    const attach = await git(deps, ['worktree', 'add', path, branch], main);
    if (attach.ok) {
      created = true;
    } else {
      // A directory deleted without `git worktree remove` leaves a stale registration
      // git refuses to re-add ("missing but already registered"). Prune clears exactly
      // that — the registration, never the branch — and the add runs once more.
      await git(deps, ['worktree', 'prune'], main);
      const retry = await git(deps, ['worktree', 'add', path, branch], main);
      if (!retry.ok) return { ok: false, error: `git worktree add failed: ${retry.stderr || retry.stdout}` };
      created = true;
    }
  }

  // Inheritance is a record, not a derivation (ADR-145). A failure here must not look
  // like success: the directory and branch EXIST but the session in it would run
  // untrusted — report the residue and how to clear it, instead of returning ok and
  // letting the mismatch surface three frames later (review P1-4).
  try {
    await deps.trust.add(spelled);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `the worktree was created at ${spelled} but inheriting trust failed (${why}); remove it with "git worktree remove ${spelled}" and delete the ${branch} branch before retrying`,
    };
  }
  return { ok: true, worktree: { path: spelled, branch, created, mainGitDir: gitDir } };
}

async function mainGitDir(deps: WorktreeDeps, main: string): Promise<string | null> {
  const result = await git(deps, ['rev-parse', '--absolute-git-dir'], main);
  return result.ok && result.stdout !== '' ? result.stdout : null;
}

export type WorktreeCleanup = 'removed' | 'kept-dirty' | 'kept-unknown';

/**
 * What an interactive exit does with the worktree (ADR-144 ⑤): a clean tree — no
 * changes, no untracked files, and no unpushed commits on the worktree branch — is
 * removed along with its branch; anything in it is preserved and named; when the check
 * itself cannot run, preservation is the safe side.
 */
export async function cleanupWorktree(deps: WorktreeDeps, info: WorktreeInfo): Promise<WorktreeCleanup> {
  const status = await git(deps, ['-C', info.path, 'status', '--porcelain'], info.path);
  if (!status.ok) return 'kept-unknown';
  if (status.stdout !== '') return 'kept-dirty';
  // A branch whose commits exist on no other branch and no remote carries work too, even
  // with a clean porcelain: deleting it would lose the only copy. `--branches --remotes`
  // excludes every ref that still has the commits — with no remote at all, commits that
  // live on the main checkout's branch still count as safe, which is the honest reading
  // of "the user has this elsewhere".
  const unpushed = await git(deps, ['-C', info.path, 'log', info.branch, '--not', '--branches', '--remotes', '--oneline'], info.path);
  if (!unpushed.ok) return 'kept-unknown';
  if (unpushed.stdout !== '') return 'kept-dirty';

  const main = deps.fs.canonical(deps.mainCwd);
  const removed = await git(deps, ['worktree', 'remove', info.path], main);
  if (!removed.ok) return 'kept-unknown';
  await git(deps, ['branch', '-D', info.branch], main);
  return 'removed';
}
