// Glob tool: minimal recursive glob matcher (no external deps). Supports **, *, ?, {a,b}, [chars].
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const MAX_RESULTS = 100;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

// Convert a glob pattern to a RegExp. `**` crosses directories; `*` stays within one segment.
export function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** or **/ -> any number of segments
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/\\\\]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/\\\\]';
      i++;
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; continue; }
      const body = pattern.slice(i + 1, end).split(',').map(escapeRe).join('|');
      re += `(?:${body})`;
      i = end + 1;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) { re += '\\['; i++; continue; }
      re += pattern.slice(i, end + 1);
      i = end + 1;
    } else {
      re += escapeRe(ch);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) {
  return s.replace(/[.+^$()|=!<>]/g, '\\$&');
}

export function walkFiles(root, { maxDepth = 30 } = {}) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push([join(dir, e.name), depth + 1]);
      } else if (e.isFile()) {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

export const GlobTool = {
  name: 'Glob',
  description: `Find files whose path matches a glob pattern, searched recursively from a directory.

When to use: locating files by name or extension — "where are the tests", "find all config files", "is there a Dockerfile anywhere". It answers "what exists" cheaply, before you spend context reading.
When NOT to use: searching file contents (use Grep), or listing a directory you already know the name of (Read specific files instead).
Patterns: ** crosses directories, * stays within one segment, ? matches one character, {a,b} alternates. Examples: src/**/*.test.js, *.{json,yaml}, packages/*/package.json.
Results are capped at 100 files and the output says when the cap was hit — do not conclude "there are no more" from a truncated list; narrow the pattern.
Failure modes: a pattern matching nothing usually means the path segment is wrong, not that the file is absent — try a broader pattern or a different root.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.js' },
      path: { type: 'string', description: 'Directory to search; defaults to the working directory' },
    },
    required: ['pattern'],
  },
  execute(input, ctx) {
    const root = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
    let stat;
    try { stat = statSync(root); } catch { return { ok: false, error: `Directory not found: ${root}` }; }
    if (!stat.isDirectory()) return { ok: false, error: `${root} is not a directory` };
    const re = globToRegExp(input.pattern);
    const all = walkFiles(root);
    const matches = all.filter((f) => re.test(relative(root, f).replace(/\\/g, '/')));
    matches.sort();
    const truncated = matches.length > MAX_RESULTS;
    const filenames = matches.slice(0, MAX_RESULTS);
    return {
      ok: true,
      output: filenames.join('\n') +
        `\n[${matches.length} match(es)${truncated ? ', truncated to first 100' : ''}]`,
    };
  },
};
