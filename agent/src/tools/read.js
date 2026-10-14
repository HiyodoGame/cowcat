// Read tool: text file read with optional line paging.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_LINES = 2000;
const LARGE_LIMIT = 5 * 1024 * 1024;
const ABSOLUTE_LIMIT = 20 * 1024 * 1024;

export const ReadTool = {
  name: 'Read',
  description: `Read a text file from the local filesystem and return its contents with line numbers.

When to use: any time you need to see what a file actually contains — before editing it, to understand how code works, to quote errors, or to check configuration. Reading a file also registers it as "read", which the Edit and Write tools require before they will touch the same file.
When NOT to use: finding files (use Glob), searching for a pattern across files (use Grep), or reading binary content — this tool only handles text.
Large files: use offset and limit to page through. Reading a whole multi-thousand-line file at once wastes context; read the region Grep pointed you to instead. Files over 5MB are rejected unless allow_large is true, which reads the file whole (no paging) up to a hard 20MB ceiling.
Failure modes: missing paths, directories, binary files and files over 5MB are reported as errors — do not retry the same call unchanged; adjust the path or range.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to read' },
      offset: { type: 'number', description: '1-based line number to start from' },
      limit: { type: 'number', description: 'Max number of lines to return' },
      allow_large: { type: 'boolean', description: 'Read files larger than 5MB whole, without line paging (still refused above 20MB). Use only when you know the file is text and you need all of it' },
    },
    required: ['file_path'],
  },
  execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.file_path);
    if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    const stat = statSync(filePath);
    if (stat.isDirectory()) return { ok: false, error: `${filePath} is a directory, not a file` };
    if (stat.size > ABSOLUTE_LIMIT) return { ok: false, error: `File too large (${stat.size} bytes, hard limit is 20MB)` };
    if (!input.allow_large && stat.size > LARGE_LIMIT) {
      return { ok: false, error: `File too large (${stat.size} bytes, limit is 5MB; set allow_large to read it whole up to 20MB)` };
    }
    const buf = readFileSync(filePath);
    if (buf.includes(0)) return { ok: false, error: 'Binary file, not readable as text' };
    const lines = buf.toString('utf8').split('\n');
    const total = lines.length;
    if (input.allow_large) {
      ctx.readSet.add(filePath);
      return { ok: true, output: lines.map((l, i) => `${i + 1}\t${l}`).join('\n') };
    }
    const offset = Math.max(1, input.offset || 1);
    const limit = Math.min(input.limit || MAX_LINES, MAX_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    ctx.readSet.add(filePath);
    return {
      ok: true,
      output: slice.map((l, i) => `${offset + i}\t${l}`).join('\n') +
        (total > slice.length ? `\n[showing lines ${offset}-${offset + slice.length - 1} of ${total}]` : ''),
    };
  },
};
