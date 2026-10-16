// git worktree isolation (P2-4): create a worktree for the session or a
// sub agent task, so changes live on a branch in a sibling directory.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Path identity matters here: the path we build with join() and the path git
// prints in `worktree list --porcelain` can differ textually (drive-letter case,
// 8.3 short names, a symlinked tmpdir) — CI on Windows showed exactly that. Both
// sides go through realpath so comparisons (and later worktree removal) agree.
export function canonicalPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export function isGitRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

// Create ../<repo>-cowcat-<name> on branch cowcat/<name>. Returns {path, branch}.
export function createWorktree(cwd, name = null) {
  if (!isGitRepo(cwd)) throw new Error(`${cwd} 不是 git 仓库`);
  const slug = (name || `task-${Date.now().toString(36)}`).replace(/[^\w.-]+/g, '-');
  const branch = `cowcat/${slug}`;
  const parent = resolve(cwd, '..');
  const path = join(parent, `${basename(cwd)}-cowcat-${slug}`);
  git(['worktree', 'add', path, '-b', branch], cwd);
  return { path: canonicalPath(path), branch, slug };
}

export function listWorktrees(cwd) {
  try {
    const out = git(['worktree', 'list', '--porcelain'], cwd);
    const trees = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: canonicalPath(line.slice(9).replace(/\//g, sep)) }; trees.push(cur); }
      else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7);
      else if (line.startsWith('detached') && cur) cur.branch = '(detached)';
    }
    return trees;
  } catch {
    return [];
  }
}
