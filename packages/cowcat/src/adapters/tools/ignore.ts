import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, join, relative } from 'node:path';

/**
 * The `.gitignore` features this walker deliberately does not implement (ADR-050).
 *
 * They are exported rather than buried because "silently missing an exclusion" is the
 * failure mode the whole task exists to remove: a build directory that stops being
 * ignored makes Glob and Grep slow and noisy, and nobody can tell why unless the real
 * scope is stated somewhere. Per-walk findings (a nested `.gitignore` that was met, a
 * pattern that could not be parsed) are reported through `limitations` instead.
 */
export const GITIGNORE_LIMITATIONS: readonly string[] = [
  'nested .gitignore files are not read (only the search root has one)',
  'global excludes (core.excludesFile) are not read',
  '.git/info/exclude is not read',
];

/**
 * Git always ignores these regardless of `.gitignore`; so does this walker, because a
 * repository without a `.gitignore` must still not walk `node_modules`.
 */
const HARD_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn']);

const DEFAULT_MAX_DEPTH = 30;

export interface WalkOptions {
  readonly maxDepth?: number;
  readonly hardSkip?: ReadonlySet<string>;
}

export interface WalkResult {
  /** Absolute paths, in no particular order — Glob sorts what it matches. */
  readonly files: readonly string[];
  /** What could not be honoured, for this tree. Empty is the ordinary case. */
  readonly limitations: readonly string[];
}

/**
 * Walks `root` and returns the files a search should see.
 *
 * Two corrections over the legacy walker (ADR-050): it honours the root `.gitignore`,
 * and it skips hidden **directories** the way `rg` does by default. The hard-skip list
 * stays, so a tree without a `.gitignore` is still safe.
 */
export function walkFiles(root: string, options: WalkOptions = {}): WalkResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const hardSkip = options.hardSkip ?? HARD_SKIP_DIRS;
  const ignore = loadIgnore(root);
  const limitations = new Set(ignore.limitations);
  const files: string[] = [];
  const pending: { readonly dir: string; readonly depth: number }[] = [{ dir: root, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > maxDepth) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is a fact about the tree, not a reason to fail the
      // whole search: the model asked "what is there", and the answer is "these".
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = join(current.dir, entry.name);
      const path = toPosix(relative(root, absolute));
      if (entry.isDirectory()) {
        if (hardSkip.has(entry.name)) continue;
        // `rg` skips hidden directories by default; the decided scope follows it
        // (ADR-050), so `.git`/`.github`/`.venv` never enter the walk.
        if (entry.name.startsWith('.')) continue;
        if (isIgnored(ignore, path, true)) continue;
        pending.push({ dir: absolute, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        if (isIgnored(ignore, path, false)) continue;
        if (entry.name === '.gitignore' && path !== '.gitignore') {
          // Not an error, but not silence either: the file exists and is NOT in effect.
          limitations.add(`nested .gitignore is not read: ${path}`);
        }
        files.push(absolute);
      }
      // Symlinks are neither: following one can leave the tree or loop, and git does
      // not follow them either.
    }
  }

  return { files, limitations: [...limitations] };
}

export interface IgnoreRule {
  /** The line as written, so a report can quote it. */
  readonly source: string;
  readonly negated: boolean;
  readonly dirOnly: boolean;
  /** A pattern with a slash is anchored to the root; one without matches any depth. */
  readonly anchored: boolean;
  readonly pattern: RegExp;
}

export interface IgnoreSet {
  readonly rules: readonly IgnoreRule[];
  readonly limitations: readonly string[];
}

/**
 * Reads `<root>/.gitignore` and compiles the supported subset (ADR-050):
 * `pattern`, `dir/`, `/anchored`, `*`, `**`, `!negation`.
 *
 * Everything else is reported rather than approximated. Escapes and character classes
 * are the two constructs that look harmless and quietly change which files are searched,
 * so they are refused by name.
 */
export function loadIgnore(root: string): IgnoreSet {
  let raw: string;
  try {
    raw = readFileSync(join(root, '.gitignore'), 'utf8');
  } catch {
    return { rules: [], limitations: [] };
  }

  const rules: IgnoreRule[] = [];
  const limitations: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    const body = negated ? line.slice(1) : line;
    if (body === '') continue;
    if (body.includes('\\') || body.includes('[') || body.includes(']')) {
      limitations.push(`unsupported .gitignore pattern: "${line}" (escapes and character classes are not implemented)`);
      continue;
    }

    const dirOnly = body.endsWith('/');
    const withoutSlash = dirOnly ? body.slice(0, -1) : body;
    const anchored = withoutSlash.includes('/');
    const pattern = withoutSlash.startsWith('/') ? withoutSlash.slice(1) : withoutSlash;
    if (pattern === '') continue;

    rules.push({ source: line, negated, dirOnly, anchored, pattern: globToIgnoreRegExp(pattern) });
  }
  return { rules, limitations };
}

/**
 * Last matching rule wins, which is what makes `!keep.log` work after `*.log`; and a
 * negation can only re-include something the walker still reaches, exactly as git's
 * "does not descend into an ignored directory" implies.
 */
export function isIgnored(ignore: IgnoreSet, path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of ignore.rules) {
    if (rule.dirOnly && !isDir) continue;
    const subject = rule.anchored ? path : basename(path);
    if (rule.pattern.test(subject)) ignored = !rule.negated;
  }
  return ignored;
}

function globToIgnoreRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        if (pattern.charAt(i + 2) === '/') {
          // `**/` also matches zero directories, so `**/x` finds a root-level `x`.
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Paths are compared with forward slashes on every platform: the patterns are written
// that way, and a Windows `\` would make a directory pattern never match (ADR-017's
// separator normalisation, one layer down).
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}
