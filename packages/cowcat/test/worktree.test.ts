// T5 — the worktree lifecycle (ADR-144/145/147). A git-scripted fake ProcessPort stands
// in for the gateway; the real-git matrix (Windows path shapes, branch reuse, exit codes)
// is the 待验证 list and is exercised by hand before the 真机验收.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFs, type ProcessPort, type ProcessResult, type ProcessSpec } from '../src/index.js';
import type { TrustSnapshot } from '../src/ports/index.js';
import { cleanupWorktree, ensureWorktree, type WorktreeDeps } from '../src/adapters/worktree.js';

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

interface GitAnswer {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * A git that answers from handlers over the full argv (including 'git' at index 0).
 * Each handler fires once, in order; anything unmatched succeeds silently.
 */
function scriptedGit(handlers: readonly ((argv: readonly string[]) => GitAnswer | null)[]): {
  process: ProcessPort;
  calls: string[][];
} {
  const calls: string[][] = [];
  const used = new Set<number>();
  const process: ProcessPort = {
    async run(spec: ProcessSpec): Promise<ProcessResult> {
      calls.push([...spec.argv]);
      const index = handlers.findIndex((handler, i) => !used.has(i) && handler(spec.argv) !== null);
      const answer = index === -1 ? undefined : (used.add(index), handlers[index]?.(spec.argv));
      return {
        exitCode: answer?.code ?? 0,
        signal: null,
        stdout: `${answer?.stdout ?? ''}\n`,
        stderr: `${answer?.stderr ?? ''}\n`,
        truncated: false,
        dropped: { stdout: 0, stderr: 0 },
        removedEnv: [],
        ignoredDeny: [],
        sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
        termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
      };
    },
    open: () => Promise.reject(new Error('open is not used here')),
  };
  return { process, calls };
}

const insideWorkTree = (argv: readonly string[]): GitAnswer | null =>
  argv[1] === 'rev-parse' && argv[2] === '--is-inside-work-tree' ? { stdout: 'true' } : null;

/** A trust store in memory, started untrusted unless seeded. */
function memoryTrust(seed: readonly string[] = []) {
  const trusted = [...seed];
  return {
    trusted: () => [...trusted],
    async load(): Promise<TrustSnapshot> {
      return { trusted, problem: null };
    },
    async add(path: string): Promise<void> {
      trusted.push(path);
    },
  };
}

function deps(t: { after(fn: () => void): void }, main: string, process: ProcessPort, trust: ReturnType<typeof memoryTrust>): WorktreeDeps {
  return { process, fs: new NodeFs(), trust, mainCwd: main };
}

test('an untrusted main checkout is refused before anything is created (ADR-145)', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const git = scriptedGit([insideWorkTree]);
  const trust = memoryTrust();
  const result = await ensureWorktree(deps(t, main, git.process, trust), 'feature-x');
  assert.equal(result.ok, false);
  assert.match(result.error, /not trusted/);
  assert.match(result.error, /cowcat trust/);
  assert.deepEqual(git.calls, [], 'no git runs at all: the trust gate is before any action');
});

test('a trusted main checkout gets a worktree, a branch, and an inherited trust record', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const git = scriptedGit([
    insideWorkTree,
    (argv) => (argv[1] === 'rev-parse' && argv[2] === '--absolute-git-dir' ? { stdout: join(main, '.git') } : null),
  ]);
  const trust = memoryTrust([main]);
  const result = await ensureWorktree(deps(t, main, git.process, trust), 'feature-x');
  assert.equal(result.ok, true);
  assert.equal(result.worktree.path, join(main, '.cowcat', 'worktrees', 'feature-x'));
  assert.equal(result.worktree.branch, 'worktree-feature-x');
  assert.equal(result.worktree.created, true);
  assert.equal(result.worktree.mainGitDir, join(main, '.git'));
  assert.deepEqual(trust.trusted(), [main, result.worktree.path], 'inheritance is an explicit record (ADR-145)');
  const add = git.calls.find((argv) => argv[1] === 'worktree' && argv[2] === 'add');
  assert.ok(add !== undefined);
  assert.equal(add[4], '-b');
  assert.equal(add[5], 'worktree-feature-x');
});

test('a surviving branch from a deleted worktree is adopted, not duplicated', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const git = scriptedGit([
    insideWorkTree,
    // `worktree add -b` fails because the branch exists; show-ref verifies it; the plain
    // add then hits git's stale registration ("missing but already registered"), prune
    // clears it, and the retry succeeds.
    (argv) => (argv[1] === 'worktree' && argv[2] === 'add' && argv.includes('-b') ? { code: 128, stderr: 'fatal: a branch named worktree-fix already exists' } : null),
    (argv) => (argv[1] === 'show-ref' ? { stdout: 'deadbeef refs/heads/worktree-fix' } : null),
    (argv) => (argv[1] === 'worktree' && argv[2] === 'add' && !argv.includes('-b') ? { code: 128, stderr: 'fatal: ... is a missing but already registered worktree' } : null),
    (argv) => (argv[1] === 'worktree' && argv[2] === 'prune' ? {} : null),
    (argv) => (argv[1] === 'worktree' && argv[2] === 'add' && !argv.includes('-b') ? {} : null),
    (argv) => (argv[1] === 'rev-parse' && argv[2] === '--absolute-git-dir' ? { stdout: join(main, '.git') } : null),
  ]);
  const trust = memoryTrust([main]);
  const result = await ensureWorktree(deps(t, main, git.process, trust), 'fix');
  assert.equal(result.ok, true);
  assert.equal(result.worktree.created, true);
  const adds = git.calls.filter((argv) => argv[1] === 'worktree' && argv[2] === 'add' && !argv.includes('-b'));
  assert.equal(adds.length, 2, 'plain add, prune, plain add again');
  assert.equal(adds[0]?.[4], 'worktree-fix', 'adoption checks out the surviving branch');
  assert.ok(git.calls.some((argv) => argv[2] === 'prune'));
});

test('an existing worktree directory is reused as-is (no re-create, no re-trust)', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const existing = join(main, '.cowcat', 'worktrees', 'keep');
  mkdirSync(existing, { recursive: true });
  const git = scriptedGit([
    insideWorkTree,
    (argv) => (argv[1] === 'rev-parse' && argv[2] === '--absolute-git-dir' ? { stdout: join(main, '.git') } : null),
  ]);
  const trust = memoryTrust([main]);
  const result = await ensureWorktree(deps(t, main, git.process, trust), 'keep');
  assert.equal(result.ok, true);
  assert.equal(result.worktree.created, false);
  assert.deepEqual(git.calls.filter((argv) => argv[1] === 'worktree'), [], 'reuse runs no git mutation');
  assert.deepEqual(trust.trusted(), [main], 'a revoked or lost record is not silently re-added');
});

test('a worktree path reached through a link is refused, not followed (ADR-144 ③)', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const elsewhere = tempDir(t, 'cowcat-wt-elsewhere-');
  mkdirSync(join(main, '.cowcat'), { recursive: true });
  symlinkSync(elsewhere, join(main, '.cowcat', 'worktrees'), 'junction');
  const git = scriptedGit([insideWorkTree]);
  const trust = memoryTrust([main]);
  const result = await ensureWorktree(deps(t, main, git.process, trust), 'sneaky');
  assert.equal(result.ok, false);
  assert.match(result.error, /link/);
});

test('unsafe names and non-git directories are refused before anything runs', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const notARepo = (argv: readonly string[]): GitAnswer | null =>
    argv[1] === 'rev-parse' && argv[2] === '--is-inside-work-tree' ? { code: 128, stderr: 'fatal: not a git repository' } : null;
  const git = scriptedGit([notARepo]);
  const trust = memoryTrust([main]);

  for (const name of ['../escape', 'a/b', '.hidden', '']) {
    const result = await ensureWorktree(deps(t, main, git.process, trust), name);
    assert.equal(result.ok, false, JSON.stringify(name));
  }

  const notGit = await ensureWorktree(deps(t, main, git.process, trust), 'fine-name');
  assert.equal(notGit.ok, false);
  assert.match(notGit.error, /not a git work tree/);
});

test('exit cleanup removes a clean worktree with its branch; dirty and unknown are kept (ADR-144 ⑤)', async (t) => {
  const main = tempDir(t, 'cowcat-wt-main-');
  const info = { path: join(main, '.cowcat', 'worktrees', 'x').replace(/\\/g, '/'), branch: 'worktree-x', created: true, mainGitDir: join(main, '.git') };
  const status = (stdout: string) => (argv: readonly string[]): GitAnswer | null =>
    argv[1] === '-C' && argv[3] === 'status' ? { stdout } : null;
  const unpushedLog = (stdout: string) => (argv: readonly string[]): GitAnswer | null =>
    argv[1] === '-C' && argv[3] === 'log' ? { stdout } : null;

  const clean = scriptedGit([status(''), unpushedLog('')]);
  assert.equal(await cleanupWorktree(deps(t, main, clean.process, memoryTrust([main])), info), 'removed');
  assert.deepEqual(clean.calls.at(-1), ['git', 'branch', '-D', 'worktree-x']);

  const dirty = scriptedGit([status(' M note.txt')]);
  assert.equal(await cleanupWorktree(deps(t, main, dirty.process, memoryTrust([main])), info), 'kept-dirty');

  const unpushed = scriptedGit([status(''), unpushedLog('abc1234 the only copy of the work')]);
  assert.equal(await cleanupWorktree(deps(t, main, unpushed.process, memoryTrust([main])), info), 'kept-dirty');
  assert.deepEqual(unpushed.calls.filter((argv) => argv[1] === 'worktree'), [], 'unpushed commits never lose their branch');

  const failedStatus = (argv: readonly string[]): GitAnswer | null =>
    argv[1] === '-C' && argv[3] === 'status' ? { code: 128, stderr: 'fatal: not a git repository' } : null;
  const unknown = scriptedGit([failedStatus]);
  assert.equal(await cleanupWorktree(deps(t, main, unknown.process, memoryTrust([main])), info), 'kept-unknown');
  assert.deepEqual(unknown.calls.filter((argv) => argv[1] === 'worktree'), [], 'a failed check never mutates');
});
