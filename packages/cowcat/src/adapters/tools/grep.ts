import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';
import { globToRegExp } from './glob.js';
import { toPosix, walkFiles } from './ignore.js';

/** The v1 caps, kept (ADR-050): the numbers are not new, their reporting is. */
export const GREP_MAX_OUTPUT_LINES = 250;
export const GREP_MAX_FILE_BYTES = 1024 * 1024;

/**
 * `type` names the way `rg --type` spells them, so the model's existing vocabulary keeps
 * working (ported from `agent/src/tools/grep.js`).
 */
export const GREP_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py', '.pyi'],
  rs: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
  cs: ['.cs'],
  rb: ['.rb'],
  php: ['.php'],
  swift: ['.swift'],
  kt: ['.kt', '.kts'],
  css: ['.css', '.scss', '.less'],
  html: ['.html', '.htm', '.vue', '.svelte'],
  json: ['.json', '.jsonc'],
  md: ['.md', '.markdown', '.mdx'],
  yml: ['.yml', '.yaml'],
  toml: ['.toml'],
  xml: ['.xml', '.svg'],
  sh: ['.sh', '.bash', '.zsh'],
  sql: ['.sql'],
};

export interface GrepToolOptions {
  /** The working directory a relative `path` is resolved against (see `createGlobTool`). */
  readonly cwd: string;
}

type OutputMode = 'content' | 'files_with_matches' | 'count';

const DESCRIPTION = [
  'Search file contents with a regular expression (JavaScript syntax) and report matching lines with line numbers, or the files that match.',
  '',
  'When to use: finding where a symbol is defined or used, tracing a string through the codebase, locating an error message, answering "does anything call this" — always search before you read whole files.',
  'When NOT to use: finding files by name (use Glob), or fetching anything from the web.',
  'Modes: files_with_matches (default) names files only — cheapest, use it first. count reports matches per file. content prints the matching lines, with -B/-A/-C context when surrounding lines matter.',
  'Filtering: glob narrows by path pattern; type restricts to a language (js, ts, py, rs, go, java, c, cpp, json, md, ...). -i ignores case. multiline lets the pattern span lines (dotall).',
  `Limits: head_limit caps the output at ${String(GREP_MAX_OUTPUT_LINES)} lines by default (0 = unlimited). files_with_matches and count STOP as soon as the cap is reached — when the result says it stopped, more matches exist.`,
  'Failure modes: an invalid regex errors — fix the pattern rather than retrying. Zero hits on a symbol you expected usually means it is generated, re-exported under another name, or lives outside the searched path; widen the path or loosen the pattern before concluding it does not exist.',
].join('\n');

export function createGrepTool(options: GrepToolOptions): ToolPort {
  return defineTool(
    {
      name: 'Grep',
      description: DESCRIPTION,
      risk: 'read',
      pathInput: 'path',
      input: z.object({
        pattern: z.string().describe('Regular expression to search for'),
        path: z.string().optional().describe('File or directory to search; defaults to the working directory'),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. *.ts'),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .describe('How to report results'),
        '-i': z.boolean().optional().describe('Case-insensitive search'),
        '-B': z.number().int().nonnegative().optional().describe('Lines of context before each match (content mode)'),
        '-A': z.number().int().nonnegative().optional().describe('Lines of context after each match (content mode)'),
        '-C': z.number().int().nonnegative().optional().describe('Lines of context on both sides (overridden by -B/-A when given)'),
        '-n': z.boolean().optional().describe('Include line numbers (default true, content mode)'),
        type: z.string().optional().describe('Only search files of this type (js, ts, py, rs, go, java, c, cpp, css, html, json, md, ...)'),
        multiline: z.boolean().optional().describe('Treat the file as one string; the regex may span lines (dotall)'),
        head_limit: z.number().int().nonnegative().optional().describe('Max output lines, 0 = unlimited'),
        offset: z.number().int().nonnegative().optional().describe('Skip the first N output lines (paging)'),
      }),
    },
    (input) => {
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern, `${input['-i'] === true ? 'i' : ''}${input.multiline === true ? 'gs' : ''}`);
      } catch (error) {
        return { ok: false, output: `invalid regex: ${error instanceof Error ? error.message : String(error)}` };
      }

      const mode: OutputMode = input.output_mode ?? 'files_with_matches';
      const target = resolve(options.cwd, input.path ?? '.');
      let targetIsDirectory: boolean;
      try {
        targetIsDirectory = statSync(target).isDirectory();
      } catch {
        return { ok: false, output: `path not found: ${target}` };
      }

      // A file target searches that file; a directory target walks it. `base` is what
      // `glob` is matched against, so `*.ts` means the same thing in both cases.
      const base = targetIsDirectory ? target : dirname(target);
      let files: readonly string[];
      let ignoreLimitations: readonly string[] = [];
      if (targetIsDirectory) {
        const walked = walkFiles(target);
        files = walked.files;
        ignoreLimitations = walked.limitations;
      } else {
        files = [target];
      }

      if (input.glob !== undefined) {
        const matcher = globToRegExp(input.glob);
        files = files.filter((file) => matcher.test(toPosix(relative(base, file))));
      }
      if (input.type !== undefined) {
        const extensions = GREP_TYPE_EXTENSIONS[input.type.toLowerCase()];
        if (extensions === undefined) {
          return {
            ok: false,
            output: `unknown type "${input.type}". Known types: ${Object.keys(GREP_TYPE_EXTENSIONS).join(', ')}`,
          };
        }
        files = files.filter((file) => extensions.some((extension) => file.toLowerCase().endsWith(extension)));
      }

      const withLineNumbers = input['-n'] !== false;
      const before = Math.max(0, mode === 'content' ? (input['-B'] ?? input['-C'] ?? 0) : 0);
      const after = Math.max(0, mode === 'content' ? (input['-A'] ?? input['-C'] ?? 0) : 0);
      const configuredLimit = input.head_limit ?? GREP_MAX_OUTPUT_LINES;
      const limit = configuredLimit === 0 ? Number.POSITIVE_INFINITY : configuredLimit;
      const offset = input.offset ?? 0;
      // Stop once `offset + limit` output lines exist: the offset part is paged out but
      // still has to be *found*, so it counts toward the stopping point.
      const stopAt = offset + limit;

      const outLines: string[] = [];
      const matchedFiles: string[] = [];
      let matchCount = 0;
      let skippedLarge = 0;
      let skippedBinary = 0;
      let stopped = false;

      for (const file of files) {
        let text: string;
        try {
          if (statSync(file).size > GREP_MAX_FILE_BYTES) {
            skippedLarge += 1;
            continue;
          }
          const buffer = readFileSync(file);
          // A NUL byte in a text file is the cheap, conventional binary signal; such a
          // file is skipped and COUNTED, not silently dropped.
          if (buffer.includes(0)) {
            skippedBinary += 1;
            continue;
          }
          text = buffer.toString('utf8');
        } catch {
          continue;
        }

        if (input.multiline === true) {
          const matches = [...text.matchAll(regex)];
          if (matches.length === 0) continue;
          matchCount += matches.length;
          matchedFiles.push(file);
          if (mode === 'files_with_matches') {
            if (matchedFiles.length >= stopAt) {
              stopped = true;
              break;
            }
            continue;
          }
          if (mode === 'count') {
            outLines.push(`${file}: ${String(matches.length)} match(es)`);
            if (outLines.length >= stopAt) {
              stopped = true;
              break;
            }
            continue;
          }
          for (const match of matches) {
            const startLine = text.slice(0, match.index).split('\n').length;
            const snippet = match[0].split('\n').slice(0, 10).join('\n');
            outLines.push(withLineNumbers ? `${file}:${String(startLine)}:${snippet}` : `${file}:${snippet}`);
            if (outLines.length >= stopAt) {
              stopped = true;
              break;
            }
          }
          if (stopped) break;
          continue;
        }

        const lines = text.split('\n');
        // A trailing newline terminates the last line; it does not start an empty one.
        if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
        const hits: number[] = [];
        for (let index = 0; index < lines.length; index += 1) {
          if (regex.test(lines[index] ?? '')) hits.push(index);
        }
        if (hits.length === 0) continue;
        matchCount += hits.length;
        matchedFiles.push(file);

        if (mode === 'files_with_matches') {
          if (matchedFiles.length >= stopAt) {
            stopped = true;
            break;
          }
          continue;
        }
        if (mode === 'count') {
          outLines.push(`${file}: ${String(hits.length)} match(es)`);
          if (outLines.length >= stopAt) {
            stopped = true;
            break;
          }
          continue;
        }

        const shown = new Set<number>();
        for (const hit of hits) {
          const first = Math.max(0, hit - before);
          const last = Math.min(lines.length - 1, hit + after);
          for (let index = first; index <= last; index += 1) shown.add(index);
        }
        let previous: number | null = null;
        for (const index of [...shown].sort((left, right) => left - right)) {
          if (previous !== null && index !== previous + 1) outLines.push('--');
          previous = index;
          const line = lines[index] ?? '';
          outLines.push(withLineNumbers ? `${file}:${String(index + 1)}:${line}` : `${file}:${line}`);
          if (outLines.length >= stopAt) {
            stopped = true;
            break;
          }
        }
        if (stopped) break;
      }

      const body = outLines.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
      const listed = matchedFiles.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
      const lines = mode === 'files_with_matches' ? listed : body;

      const summary = [
        `${String(matchedFiles.length)} file(s)`,
        `${String(matchCount)} match(es)`,
        ...(skippedLarge > 0 ? [`${String(skippedLarge)} file(s) skipped (over 1 MiB)`] : []),
        ...(skippedBinary > 0 ? [`${String(skippedBinary)} binary file(s) skipped`] : []),
        ...(stopped ? [`stopped at head_limit ${String(configuredLimit)}`] : []),
      ];
      const report = [`[${summary.join(', ')}]`];
      if (ignoreLimitations.length > 0) report.push(`[.gitignore: ${ignoreLimitations.join('; ')}]`);
      const output = lines.length > 0 ? `${lines.join('\n')}\n${report.join('\n')}` : report.join('\n');

      return {
        ok: true,
        output,
        // Early exit means the total is unknown, which is a fact of its own kind
        // (ADR-053): `null` says "stopped, did not count", never "dropped nothing".
        truncation: {
          truncated: stopped,
          dropped: stopped ? null : 0,
          reason: stopped ? `grep: head_limit ${String(configuredLimit)}` : null,
        },
      };
    },
  );
}
