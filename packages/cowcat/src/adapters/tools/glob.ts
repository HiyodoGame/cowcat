import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';
import { toPosix, walkFiles } from './ignore.js';

/** The v1 cap, kept (ADR-050): the number is not new, only its reporting is. */
export const GLOB_MAX_RESULTS = 100;

export interface GlobToolOptions {
  /**
   * The working directory a relative `path` is resolved against. Injected rather than
   * read from `process.cwd()` so the tool is a value the composition root owns (P6),
   * the same way `FsPort` is.
   */
  readonly cwd: string;
}

export function createGlobTool(options: GlobToolOptions): ToolPort {
  return defineTool(
    {
      name: 'Glob',
      description: [
        'Find files whose path matches a glob pattern, searched recursively from a directory.',
        '',
        'When to use: locating files by name or extension — "where are the tests", "find all config files", "is there a Dockerfile anywhere". It answers "what exists" cheaply, before you spend context reading.',
        'When NOT to use: searching file contents (use Grep), or reading a file whose path you already know (use Read).',
        'Patterns: ** crosses directories, * stays within one segment, ? matches one character, {a,b} alternates. Examples: src/**/*.test.ts, *.{json,yaml}, packages/*/package.json.',
        'The walk honours the search root\'s .gitignore, always skips node_modules/.git/.hg/.svn and hidden directories, and does not read nested .gitignore files (a result that met one says so).',
        `Results are capped at ${String(GLOB_MAX_RESULTS)} files and the result says when the cap was hit — do not conclude "there are no more" from a truncated list; narrow the pattern.`,
        'Failure modes: a pattern matching nothing usually means a path segment is wrong, not that the file is absent — try a broader pattern or a different root.',
      ].join('\n'),
      risk: 'read',
      // A rule may narrow on the directory being searched. Absent `path` means the
      // tool's own cwd, which no rule can name — the search is still readable by
      // `reads-are-free`, but a path-based deny does not apply to it.
      pathInput: 'path',
      input: z.object({
        pattern: z.string().describe('Glob pattern, e.g. src/**/*.ts'),
        path: z.string().optional().describe('Directory to search; defaults to the working directory'),
      }),
    },
    (input) => {
      const root = resolve(options.cwd, input.path ?? '.');
      let isDirectory = false;
      try {
        isDirectory = statSync(root).isDirectory();
      } catch {
        return { ok: false, output: `directory not found: ${root}` };
      }
      if (!isDirectory) return { ok: false, output: `${root} is not a directory` };

      const { files, limitations } = walkFiles(root);
      const matcher = globToRegExp(input.pattern);
      const matches = files.filter((file) => matcher.test(toPosix(relative(root, file)))).sort();

      const truncated = matches.length > GLOB_MAX_RESULTS;
      const shown = matches.slice(0, GLOB_MAX_RESULTS);
      const lines = [
        ...shown,
        `[${String(matches.length)} match(es)${truncated ? `, truncated to first ${String(GLOB_MAX_RESULTS)}` : ''}]`,
      ];
      if (limitations.length > 0) lines.push(`[.gitignore: ${limitations.join('; ')}]`);

      return {
        ok: true,
        output: lines.join('\n'),
        // Reported even when false: "nothing was dropped" is a fact the audit can use,
        // and it is different from a tool that reports nothing (ADR-048).
        truncation: {
          truncated,
          dropped: truncated ? matches.length - GLOB_MAX_RESULTS : 0,
          reason: truncated ? `glob: first ${String(GLOB_MAX_RESULTS)} matches` : null,
        },
      };
    },
  );
}

/**
 * Ported from the legacy `agent/src/tools/glob.js` (same grammar: `**`, `*`, `?`,
 * `{a,b}`, `[chars]`), because "the pattern the user already knows" is part of the tool's
 * behaviour and changing it would be a silent migration.
 *
 * Matching is against a **relative posix path**: absolute paths would make `**` depend
 * on how deep the search root happens to sit.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        // `**` crosses directories, and `**/` may match none of them.
        source += '.*';
        i += 1;
        if (pattern.charAt(i + 1) === '/') i += 1;
      } else {
        source += '[^/\\\\]*';
      }
    } else if (ch === '?') {
      source += '[^/\\\\]';
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        source += '\\{';
        continue;
      }
      const body = pattern
        .slice(i + 1, end)
        .split(',')
        .map(escapeRegExp)
        .join('|');
      source += `(?:${body})`;
      i = end;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      // A character class is copied verbatim: escaping its contents would invert what
      // the user wrote. `globToIgnoreRegExp` refuses classes instead — different jobs.
      source += pattern.slice(i, end + 1);
      i = end;
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|=!<>]/g, '\\$&');
}
