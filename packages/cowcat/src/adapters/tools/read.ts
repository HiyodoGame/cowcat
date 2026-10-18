import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

/** The v1 caps, kept (ADR-050): the numbers are not new, their reporting is. */
export const READ_MAX_LINES = 2000;
export const READ_LARGE_LIMIT = 5 * 1024 * 1024;
export const READ_ABSOLUTE_LIMIT = 20 * 1024 * 1024;

/** Formats the legacy tool handed to the model as attachments; P7 owns them in v2. */
const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.heic',
  '.avif',
  '.pdf',
]);

export interface ReadToolOptions {
  /** The working directory a relative `file_path` is resolved against. */
  readonly cwd: string;
}

const DESCRIPTION = [
  'Read a text file from the local filesystem, with line numbers.',
  '',
  'When to use: any time you need to see what a file actually contains — before editing it, to understand how code works, to quote errors, to check configuration. Reading a file also registers it as read, which Edit and Write require before they touch the same file.',
  'When NOT to use: finding files (use Glob), searching for a pattern across files (use Grep).',
  `Text files: use offset and limit to page through; at most ${String(READ_MAX_LINES)} lines come back per call. Reading a whole multi-thousand-line file at once wastes context — read the region Grep pointed you to instead. Files over 5MB are refused unless allow_large is true, which reads the file whole (no paging) up to a hard 20MB ceiling.`,
  'Line endings: a file that uses CRLF says so in the result. Matching text for an edit must then include the carriage returns, because the bytes are not normalised.',
  'Not supported yet: images, PDFs and Jupyter notebooks. v2 has no channel for handing bytes to the model, so those are refused and planned for P7 — convert them to text first.',
  'Failure modes: missing paths, directories, binary files and oversized files are reported as errors — do not retry the same call unchanged; adjust the path, range, or convert the file.',
].join('\n');

export function createReadTool(options: ReadToolOptions): ToolPort {
  return defineTool(
    {
      name: 'Read',
      description: DESCRIPTION,
      risk: 'read',
      pathInput: 'file_path',
      input: z.object({
        file_path: z.string().describe('Path of the file to read'),
        offset: z.number().int().positive().optional().describe('1-based line number to start from'),
        limit: z.number().int().positive().optional().describe(`Max number of lines to return (at most ${String(READ_MAX_LINES)})`),
        allow_large: z
          .boolean()
          .optional()
          .describe('Read text files larger than 5MB whole, without line paging (still refused above 20MB)'),
      }),
    },
    (input) => {
      const filePath = resolve(options.cwd, input.file_path);
      let size: number;
      let isDirectory: boolean;
      try {
        const stat = statSync(filePath);
        size = stat.size;
        isDirectory = stat.isDirectory();
      } catch {
        return { ok: false, output: `file not found: ${filePath}` };
      }
      if (isDirectory) return { ok: false, output: `${filePath} is a directory, not a file` };

      if (size > READ_ABSOLUTE_LIMIT) {
        return {
          ok: false,
          output: `file too large (${String(size)} bytes; the hard limit is 20MB and allow_large does not raise it)`,
        };
      }

      const extension = extname(filePath).toLowerCase();
      const attachmentKind = describeAttachment(extension);
      if (attachmentKind !== null) return { ok: false, output: attachmentKind };

      let buffer: Buffer;
      try {
        buffer = readFileSync(filePath);
      } catch {
        return { ok: false, output: `cannot read ${filePath}` };
      }

      // Magic beats extension: a PDF renamed to `.txt` is still not text, and passing its
      // bytes through as UTF-8 is how a transcript gets silently corrupted.
      if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
        return { ok: false, output: notYet('PDF') };
      }
      if (buffer.includes(0)) return { ok: false, output: `binary file, not readable as text: ${filePath}` };

      if (size > READ_LARGE_LIMIT && input.allow_large !== true) {
        return {
          ok: false,
          output: `file too large (${String(size)} bytes; the limit is 5MB — set allow_large to read it whole up to 20MB)`,
        };
      }

      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      // A trailing newline terminates the last line; it does not start an empty one.
      if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
      const total = lines.length;

      const endings = describeLineEndings(text);

      if (input.allow_large === true) {
        const body = lines.map((line, index) => `${String(index + 1)}\t${line}`).join('\n');
        return {
          ok: true,
          output: [body, ...endings].filter((part) => part !== '').join('\n'),
          truncation: { truncated: false, dropped: 0, reason: null },
        };
      }

      // offset is 1-based and clamped rather than refused: a model paging one line past
      // the end should get an empty page with the range, not an error it will retry.
      const offset = input.offset ?? 1;
      const limit = Math.min(input.limit ?? READ_MAX_LINES, READ_MAX_LINES);
      const shown = lines.slice(offset - 1, offset - 1 + limit);
      const firstLine = offset;
      const lastLine = offset + shown.length - 1;
      const body = shown.map((line, index) => `${String(offset + index)}\t${line}`).join('\n');
      const footer = shown.length < total ? `[showing lines ${String(firstLine)}-${String(lastLine)} of ${String(total)}]` : '';

      return {
        ok: true,
        output: [body, footer, ...endings].filter((part) => part !== '').join('\n'),
        truncation: {
          truncated: shown.length < total,
          dropped: total - shown.length,
          reason: shown.length < total ? `read: lines ${String(firstLine)}-${String(lastLine)} of ${String(total)}` : null,
        },
      };
    },
  );
}

// Refused and pointed at P7 rather than half-supported: v2's `Message` union has no
// attachment arm, so "reading" an image would mean inventing a channel (dev-plan-v2 P5
// range 5). The refusal must name where the capability went, or it reads as a bug.
function describeAttachment(extension: string): string | null {
  if (extension === '.ipynb') return notYet('Jupyter notebook');
  if (ATTACHMENT_EXTENSIONS.has(extension)) return notYet(extension === '.pdf' ? 'PDF' : 'image');
  return null;
}

function notYet(kind: 'image' | 'PDF' | 'Jupyter notebook'): string {
  const head = `cannot read ${
    kind === 'image' ? 'images' : kind === 'PDF' ? 'PDFs' : 'Jupyter notebooks'
  } yet: v2 has no way to hand bytes to the model (attachment support is planned for P7).`;
  const tail =
    kind === 'Jupyter notebook'
      ? 'Read the raw .ipynb JSON with offset/limit instead.'
      : `Convert the ${kind === 'image' ? 'image' : 'PDF'} to text first.`;
  return `${head} ${tail}`;
}

/**
 * Reports the line-ending style only when it is not plain LF.
 *
 * Silent LF is the ordinary case and needs no fact; CRLF is the case that breaks edits,
 * because the returned line text still ends in `\r` that the model cannot see (ADR-050,
 * research §6.2). The fix is to say it out loud, never to normalise the bytes.
 */
function describeLineEndings(text: string): readonly string[] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return [];
  const totalLf = (text.match(/\n/g) ?? []).length;
  return [totalLf > crlf ? '[file uses mixed line endings: CRLF and LF]' : '[file uses CRLF line endings]'];
}
