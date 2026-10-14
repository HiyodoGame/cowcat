// Grep tool: line-based regex search over files, implemented in pure Node.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { globToRegExp, walkFiles } from './glob.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_LINES = 250;

// file-type -> extension list (aligned with the reference CLI's rg --type names)
export const TYPE_EXTENSIONS = {
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

export const GrepTool = {
  name: 'Grep',
  description: `Search file contents with a regular expression (JavaScript syntax) and report matching lines with line numbers, or the files that match.

When to use: finding where a symbol is defined or used, tracing a string through the codebase, locating an error message, answering "does anything call this" — always search before you read whole files.
When NOT to use: finding files by name (use Glob) or fetching anything from the web.
Modes: files_with_matches (default) names files only — cheapest, use it first. count reports matches per file. content prints the matching lines, with -B/-A/-C context when surrounding lines matter.
Filtering: glob narrows by path pattern; type restricts to a language (js, ts, py, rs, go, java, c, cpp, json, md, ...). -i ignores case. multiline lets the pattern span lines (dotall).
Failure modes: an invalid regex errors — fix the pattern rather than retrying. Zero hits on a symbol you expected usually means it is generated, re-exported under another name, or lives outside the searched path; widen the path or loosen the pattern before concluding it does not exist.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search; defaults to the working directory' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.js' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'How to report results' },
      '-i': { type: 'boolean', description: 'Case-insensitive search' },
      '-B': { type: 'number', description: 'Lines of context before each match (content mode)' },
      '-A': { type: 'number', description: 'Lines of context after each match (content mode)' },
      '-C': { type: 'number', description: 'Lines of context on both sides (overridden by -B/-A when given)' },
      '-n': { type: 'boolean', description: 'Include line numbers (default true, content mode)' },
      type: { type: 'string', description: 'Only search files of this type (js, ts, py, rs, go, java, c, cpp, css, html, json, md, ...)' },
      multiline: { type: 'boolean', description: 'Treat the file as one string; the regex may span lines (dotall)' },
      head_limit: { type: 'number', description: 'Max output lines, 0 = unlimited' },
      offset: { type: 'number', description: 'Skip the first N output lines (content mode paging)' },
    },
    required: ['pattern'],
  },
  execute(input, ctx) {
    let regex;
    try {
      const flags = (input['-i'] ? 'i' : '') + (input.multiline ? 'gs' : '');
      regex = new RegExp(input.pattern, flags);
    } catch (e) {
      return { ok: false, error: `Invalid regex: ${e.message}` };
    }
    const mode = input.output_mode || 'files_with_matches';
    const target = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
    let files;
    try {
      const st = statSync(target);
      files = st.isDirectory() ? walkFiles(target) : [target];
    } catch {
      return { ok: false, error: `Path not found: ${target}` };
    }
    if (input.glob) {
      const gre = globToRegExp(input.glob);
      files = files.filter((f) => gre.test(f.replace(/\\/g, '/')));
    }
    if (input.type) {
      const exts = TYPE_EXTENSIONS[input.type.toLowerCase()];
      if (!exts) return { ok: false, error: `Unknown type "${input.type}". Known types: ${Object.keys(TYPE_EXTENSIONS).join(', ')}` };
      files = files.filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
    }

    const withLineNums = input['-n'] !== false;
    const ctxB = mode === 'content' ? Math.max(0, input['-B'] ?? input['-C'] ?? 0) : 0;
    const ctxA = mode === 'content' ? Math.max(0, input['-A'] ?? input['-C'] ?? 0) : 0;
    const headLimit = input.head_limit ?? MAX_OUTPUT_LINES;
    const offset = input.offset || 0;
    const outLines = [];
    const matchedFiles = [];
    let numMatches = 0;
    let skipped = 0;

    outer: for (const file of files) {
      let buf;
      try {
        const st = statSync(file);
        if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
        buf = readFileSync(file);
        if (buf.includes(0)) continue; // binary
      } catch { continue; }
      const text = buf.toString('utf8');

      if (input.multiline) {
        // whole-file matching; report each match block with its start line
        const matches = [...text.matchAll(regex)];
        if (matches.length === 0) continue;
        numMatches += matches.length;
        matchedFiles.push(file);
        if (mode === 'files_with_matches') continue;
        if (mode === 'count') {
          outLines.push(`${file}: ${matches.length} match(es)`);
          if (outLines.length >= (headLimit || Infinity) + offset) break outer;
          continue;
        }
        for (const m of matches) {
          const startLine = text.slice(0, m.index).split('\n').length;
          const snippet = m[0].split('\n').slice(0, 10).join('\n'); // cap runaway matches
          outLines.push(`${withLineNums ? `${startLine}:` : ''}${snippet}`);
          if (outLines.length >= (headLimit || Infinity) + offset) break outer;
        }
        continue;
      }

      const lines = text.split('\n');
      const hitIdx = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) hitIdx.push(i);
      }
      if (hitIdx.length === 0) continue;
      numMatches += hitIdx.length;
      matchedFiles.push(file);
      if (mode === 'files_with_matches') continue;
      if (mode === 'count') {
        outLines.push(`${file}: ${hitIdx.length} match(es)`);
        if (outLines.length >= (headLimit || Infinity) + offset) break outer;
        continue;
      }
      // content mode
      const shown = new Set();
      for (const i of hitIdx) {
        for (let c = Math.max(0, i - ctxB); c <= Math.min(lines.length - 1, i + ctxA); c++) shown.add(c);
      }
      let prev = -2;
      for (const i of [...shown].sort((a, b) => a - b)) {
        if (i !== prev + 1 && prev !== -2) outLines.push('--');
        prev = i;
        outLines.push(`${withLineNums ? `${i + 1}:` : ''}${lines[i]}`);
        if (outLines.length >= (headLimit || Infinity) + offset) break outer;
      }
    }

    const paged = outLines.slice(offset, headLimit ? offset + headLimit : undefined);
    const header = `[${matchedFiles.length} file(s), ${numMatches} match(es)${skipped ? `, ${skipped} file(s) skipped (too large)` : ''}]`;
    const body = mode === 'files_with_matches'
      ? matchedFiles.slice(offset, headLimit ? offset + headLimit : undefined).join('\n')
      : paged.join('\n');
    return { ok: true, output: `${body ? `${body}\n` : ''}${header}` };
  },
};
