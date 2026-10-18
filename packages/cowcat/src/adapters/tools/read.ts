import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { z } from 'zod';
import { ATTACHMENT_HARD_LIMIT_BYTES, ATTACHMENT_SOFT_LIMIT_BYTES, makeAttachment, type ToolPort, type ToolResult } from '../../ports/index.js';
import { defineTool } from './define-tool.js';
import { describeDimensions, formatBytes, kindFromExtension, sniffBuffer } from '../imageinfo.js';
import { DEFAULT_MAX_OUTPUT_CHARS, parseNotebook, renderNotebook } from '../notebook.js';

/** The v1 caps, kept (ADR-050): the numbers are not new, their reporting is. */
export const READ_MAX_LINES = 2000;
export const READ_LARGE_LIMIT = 5 * 1024 * 1024;
export const READ_ABSOLUTE_LIMIT = 20 * 1024 * 1024;

export interface ReadToolOptions {
  /** The working directory a relative `file_path` is resolved against. */
  readonly cwd: string;
}

const DESCRIPTION = [
  'Read a file from the local filesystem.',
  '',
  'When to use: any time you need to see what a file actually contains — before editing it, to understand how code works, to quote errors, to check configuration, or to look at a screenshot, diagram or document. Reading a file also registers it as read, which Edit and Write require before they touch the same file.',
  'When NOT to use: finding files (use Glob), searching for a pattern across files (use Grep).',
  `Text files: use offset and limit to page through; at most ${String(READ_MAX_LINES)} lines come back per call. Reading a whole multi-thousand-line file at once wastes context — read the region Grep pointed you to instead. Text files over 5MB are refused unless allow_large is true, which reads the file whole (no paging) up to a hard 20MB ceiling.`,
  'Images (.png/.jpg/.jpeg/.gif/.webp) and PDFs are attached for you to look at: the result is a short header (name, type, size, and dimensions or page count), while the bytes ride the next model request. The same 5MB/20MB limits apply, with the same allow_large escape; offset and limit do not apply.',
  'PDFs are only seen by a model whose endpoint accepts documents. On a protocol with no document part the model receives a reference plus a note saying so, and it will tell you it could not read the file.',
  "Notebooks (.ipynb) come back rendered cell by cell with each cell's text outputs. Image outputs are reported by size but not attached: they live inside the notebook JSON, so there is no file to reference. offset and limit do not apply.",
  'Line endings: a file that uses CRLF says so in the result. Matching text for an edit must then include the carriage returns, because the bytes are not normalised.',
  'Failure modes: missing paths, directories, a file whose content is not the type its name promises, unsupported image formats, binary files and oversized files are reported as errors — do not retry the same call unchanged; adjust the path, range, or convert the file.',
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
          .describe('Read files larger than 5MB whole, without line paging (still refused above 20MB)'),
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

      let buffer: Buffer;
      try {
        buffer = readFileSync(filePath);
      } catch {
        return { ok: false, output: `cannot read ${filePath}` };
      }

      // A notebook is JSON, so it sniffs as text — and it is *rendered*, never attached
      // (ADR-057: an image output lives inside the JSON with no file to reference).
      if (extname(filePath).toLowerCase() === '.ipynb') return readNotebook(filePath, buffer);

      const sniffed = sniffBuffer(buffer);
      if (sniffed.kind === 'png' || sniffed.kind === 'jpeg' || sniffed.kind === 'gif' || sniffed.kind === 'webp') {
        return readImage(filePath, size, sniffed, input.allow_large === true);
      }
      if (sniffed.kind === 'pdf') return readPdf(filePath, size, sniffed.pages, input.allow_large === true);
      if (sniffed.kind === 'image-unsupported') {
        return {
          ok: false,
          output: `${filePath} is a ${sniffed.format} image, which neither model protocol accepts (png/jpeg/gif/webp only). Convert it first.`,
        };
      }
      if (sniffed.kind === 'binary') return { ok: false, output: `binary file, not readable as text: ${filePath}` };

      // Content and name disagree. Magic wins — and the mismatch is said out loud rather
      // than handing bytes to the model as text, which is how a transcript gets silently
      // corrupted.
      const promised = kindFromExtension(filePath);
      if (promised !== null) {
        return {
          ok: false,
          output: `the name promises a ${promised === 'image-unsupported' ? 'binary image' : promised} but the content is not one; refusing to read these bytes as text`,
        };
      }

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

/**
 * The bytes are never in the result — an attachment is a reference (ADR-057), and this
 * header is what the model reads to know what it is about to see.
 */
function readImage(
  filePath: string,
  size: number,
  sniffed: { readonly mediaType: string; readonly width: number | null; readonly height: number | null },
  allowLarge: boolean,
): ToolResult {
  const refused = refuseOverSoftLimit(size, allowLarge);
  if (refused !== null) return { ok: false, output: refused };

  const dimensions = describeDimensions(sniffed.width, sniffed.height);
  return {
    ok: true,
    output: [
      `[image] ${basename(filePath)} — ${sniffed.mediaType}${dimensions === '' ? '' : `, ${dimensions}`}, ${formatBytes(size)} (attached for the model)`,
      '[whole file read; offset/limit do not apply to images]',
    ].join('\n'),
    truncation: { truncated: false, dropped: 0, reason: null },
    attachments: [
      makeAttachment({
        type: 'image',
        mediaType: sniffed.mediaType,
        path: filePath,
        bytes: size,
        width: sniffed.width,
        height: sniffed.height,
      }),
    ],
  };
}

function readPdf(filePath: string, size: number, pageCount: number, allowLarge: boolean): ToolResult {
  const refused = refuseOverSoftLimit(size, allowLarge);
  if (refused !== null) return { ok: false, output: refused };

  // A count of 0 means the counter could not find page objects (PDF 1.5+ compresses them
  // away), which is "not reported" — not "no pages".
  const pages = pageCount > 0 ? pageCount : null;
  return {
    ok: true,
    output: [
      `[pdf] ${basename(filePath)} — application/pdf${pages === null ? '' : `, ${String(pages)} page${pages === 1 ? '' : 's'}`}, ${formatBytes(size)} (attached for the model)`,
      '[whole file read; offset/limit do not apply to PDFs]',
    ].join('\n'),
    truncation: { truncated: false, dropped: 0, reason: null },
    attachments: [
      makeAttachment({ type: 'document', mediaType: 'application/pdf', path: filePath, bytes: size, pages }),
    ],
  };
}

function readNotebook(filePath: string, buffer: Buffer): ToolResult {
  const parsed = parseNotebook(buffer.toString('utf8'));
  if (!parsed.ok) return { ok: false, output: `not a readable notebook (${parsed.error}): ${filePath}` };

  const rendered = renderNotebook(parsed.notebook, { path: filePath });
  return {
    ok: true,
    output: `${rendered.text}\n[no offset/limit for notebooks; image outputs are not attached]`,
    truncation: rendered.truncated
      ? { truncated: true, dropped: null, reason: `notebook: outputs capped at ${String(DEFAULT_MAX_OUTPUT_CHARS)} chars each` }
      : { truncated: false, dropped: 0, reason: null },
  };
}

/**
 * The 5MB/20MB口径, applied to bytes (ADR-057) rather than to lines: a binary has no
 * pageable unit, so the soft limit is a refusal with an escape hatch and the hard limit
 * is final. The adapter's materializer checks the hard limit again at request time — the
 * file may have grown since it was read.
 */
function refuseOverSoftLimit(size: number, allowLarge: boolean): string | null {
  if (size > ATTACHMENT_HARD_LIMIT_BYTES) {
    return `file too large to attach (${formatBytes(size)}; the hard limit is ${formatBytes(ATTACHMENT_HARD_LIMIT_BYTES)} and allow_large does not raise it)`;
  }
  if (size > ATTACHMENT_SOFT_LIMIT_BYTES && !allowLarge) {
    return `file too large to attach (${formatBytes(size)}; the limit is ${formatBytes(ATTACHMENT_SOFT_LIMIT_BYTES)} — set allow_large to attach it whole up to ${formatBytes(ATTACHMENT_HARD_LIMIT_BYTES)})`;
  }
  return null;
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
