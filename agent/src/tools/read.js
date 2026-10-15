// Read tool: text files (with line paging), notebooks (rendered cell by cell),
// and binary content — images and PDFs — which is attached to the model instead
// of being refused.
//
// Binary handling: the tool never puts bytes into the transcript. It returns an
// attachment REFERENCE (path + metadata) plus a short text header; the bytes are
// read back at request time (src/attach.js). See docs/read-multimodal-plan.md.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import {
  sniffBuffer, kindFromExtension, countPdfPages, estimateImageTokens, formatBytes, describeDimensions,
} from '../imageinfo.js';
import { makeAttachment, maxBytesFor } from '../attach.js';
import { visionCapability, visionRefusalMessage } from '../vision.js';
import { parseNotebook, renderNotebook } from '../notebook.js';
import { extractPdfText } from '../pdftext.js';

const MAX_LINES = 2000;
const LARGE_LIMIT = 5 * 1024 * 1024;
const ABSOLUTE_LIMIT = 20 * 1024 * 1024;
const NOTEBOOK_RENDER_LIMIT = 400 * 1024;

export const ReadTool = {
  name: 'Read',
  description: `Read a file from the local filesystem: text files come back with line numbers, images and PDFs are attached for you to see, and Jupyter notebooks are rendered cell by cell.

When to use: any time you need to see what a file actually contains — before editing it, to understand how code works, to quote errors, to check configuration, or to look at a screenshot/design/diagram (image files: .png/.jpg/.gif/.webp) or a document (.pdf). Reading a file also registers it as "read", which the Edit and Write tools require before they will touch the same file.
When NOT to use: finding files (use Glob), searching for a pattern across files (use Grep).
Text files: use offset and limit to page through. Reading a whole multi-thousand-line file at once wastes context; read the region Grep pointed you to instead. Files over 5MB are rejected unless allow_large is true, which reads the file whole (no paging) up to a hard 20MB ceiling.
Notebooks (.ipynb): returned as [notebook] plus one block per cell (\`--- cell [n] type ---\` with numbered source and \`--- output [n.m] ---\` for outputs). Image outputs are reported by size but not attached. offset/limit do not apply — use NotebookEdit with the cell index to change cells.
Images/PDFs: offset/limit do not apply. Images are limited to 5MB and PDFs to 10MB. Some models cannot accept image input; when the configured model is known not to, this tool refuses with an explanation instead of failing at the API.
Failure modes: missing paths, directories, unreadable or unsupported binaries, and oversized files are reported as errors — do not retry the same call unchanged; adjust the path, range, or convert the file.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to read' },
      offset: { type: 'number', description: '1-based line number to start from (text files only)' },
      limit: { type: 'number', description: 'Max number of lines to return (text files only)' },
      allow_large: { type: 'boolean', description: 'Read text files larger than 5MB whole, without line paging (still refused above 20MB). Use only when you know the file is text and you need all of it' },
    },
    required: ['file_path'],
  },
  execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.file_path);
    if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    const stat = statSync(filePath);
    if (stat.isDirectory()) return { ok: false, error: `${filePath} is a directory, not a file` };

    const extKind = kindFromExtension(filePath);
    if (stat.size > ABSOLUTE_LIMIT) {
      if (extKind === 'pdf') return { ok: false, error: oversized(stat.size, 'document') };
      if (extKind && extKind !== 'pdf') return { ok: false, error: oversized(stat.size, 'image') };
      return { ok: false, error: `File too large (${stat.size} bytes, hard limit is 20MB)` };
    }

    const buf = readFileSync(filePath);
    const sniff = sniffBuffer(buf);

    if (sniff.kind === 'pdf') return readPdf({ filePath, buf, stat, ctx });
    if (sniff.kind === 'png' || sniff.kind === 'jpeg' || sniff.kind === 'gif' || sniff.kind === 'webp') {
      return readImage({ filePath, sniff, stat, ctx });
    }
    if (sniff.kind === 'image-unsupported') {
      return {
        ok: false,
        error: `${basename(filePath)} is a ${String(sniff.format).toUpperCase()} image; only png, jpeg, gif and webp can be handed to the model. Convert it first.`,
      };
    }
    if (sniff.kind === 'binary') {
      if (extKind) {
        return { ok: false, error: `${basename(filePath)} is named like a ${extKind.toUpperCase()} file but its content is not a recognizable one — refusing to pass binary data through as text.` };
      }
      return { ok: false, error: 'Binary file, not readable as text' };
    }

    // Text content from here on (including .ipynb, which is JSON text).
    if (extname(filePath).toLowerCase() === '.ipynb') return readNotebook({ filePath, buf, stat, ctx });

    if (!input.allow_large && stat.size > LARGE_LIMIT) {
      return { ok: false, error: `File too large (${stat.size} bytes, limit is 5MB; set allow_large to read it whole up to 20MB)` };
    }
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

function oversized(size, type) {
  const limit = maxBytesFor(type);
  const what = type === 'document' ? 'PDF input' : 'image input';
  return `File is ${formatBytes(size)}; the limit for model ${what} is ${formatBytes(limit)}. Downsize or convert it first.`;
}

function readImage({ filePath, sniff, stat, ctx }) {
  const config = ctx.config || {};
  const cap = visionCapability(config);
  if (cap.support === 'no') return { ok: false, error: visionRefusalMessage(config, { mediaKind: 'image' }) };
  const limit = maxBytesFor('image');
  if (stat.size > limit) return { ok: false, error: oversized(stat.size, 'image') };

  const attachment = makeAttachment({
    type: 'image',
    mediaType: sniff.mediaType,
    path: filePath,
    bytes: stat.size,
    tokens: estimateImageTokens({ kind: sniff.kind, width: sniff.width, height: sniff.height, bytes: stat.size }),
    width: sniff.width,
    height: sniff.height,
  });
  ctx.readSet.add(filePath);
  const dims = describeDimensions(sniff);
  const lines = [
    `[image] ${basename(filePath)} — ${sniff.mediaType}${dims ? `, ${dims}` : ''}, ${formatBytes(stat.size)} (attached for the model)`,
    '[whole file read; offset/limit do not apply to images]',
  ];
  if (cap.support === 'unknown') {
    lines.push(`[model "${config.model || 'unset'}" is not in the model catalog — if the upstream rejects image input, switch to a vision-capable model or set COWCAT_VISION=off]`);
  }
  return { ok: true, output: lines.join('\n'), attachments: [attachment] };
}

function readPdf({ filePath, buf, stat, ctx }) {
  const config = ctx.config || {};
  const cap = visionCapability(config);
  if (cap.support === 'no') return { ok: false, error: visionRefusalMessage(config, { mediaKind: 'PDF' }) };
  const limit = maxBytesFor('document');
  if (stat.size > limit) return { ok: false, error: oversized(stat.size, 'document') };
  const pages = countPdfPages(buf);
  const head = `${basename(filePath)} — application/pdf${pages ? `, ${pages} page${pages === 1 ? '' : 's'}` : ''}, ${formatBytes(stat.size)}`;

  // Anthropic protocol takes the document natively.
  if (config.protocol === 'anthropic') {
    const attachment = makeAttachment({
      type: 'document',
      mediaType: 'application/pdf',
      path: filePath,
      bytes: stat.size,
      tokens: estimateImageTokens({ kind: 'pdf', pages, bytes: stat.size }),
      pages,
    });
    ctx.readSet.add(filePath);
    return {
      ok: true,
      output: `[pdf] ${head} (attached for the model)\n[whole file read; offset/limit do not apply to PDFs]`,
      attachments: [attachment],
    };
  }

  // OpenAI-compatible protocols have no PDF input: fall back to best-effort text.
  const extracted = extractPdfText(buf);
  if (!extracted.ok) {
    return {
      ok: false,
      error: `[pdf] ${head}: this provider's protocol cannot accept a PDF as input, and best-effort text extraction failed (${extracted.reason}). Convert the PDF to text first, or read it with an Anthropic-protocol provider.`,
    };
  }
  ctx.readSet.add(filePath);
  const tail = extracted.truncated ? `\n[text truncated at ${extracted.chars} characters]` : '';
  return {
    ok: true,
    output: `[pdf] ${head}; text extracted best-effort (no page boundaries; complex or CID-encoded PDFs can lose characters)\n\n${extracted.text}${tail}`,
  };
}

function readNotebook({ filePath, buf, stat, ctx }) {
  const parsed = parseNotebook(buf.toString('utf8'));
  if (!parsed.ok) return { ok: false, error: `${basename(filePath)} is not a readable notebook: ${parsed.error}` };
  let rendered = renderNotebook(parsed.nb, { path: filePath });
  if (rendered.length > NOTEBOOK_RENDER_LIMIT) {
    rendered = `${rendered.slice(0, NOTEBOOK_RENDER_LIMIT)}\n[notebook output truncated at ${NOTEBOOK_RENDER_LIMIT} characters; read the .ipynb file directly with offset/limit for the rest]`;
  }
  ctx.readSet.add(filePath);
  return {
    ok: true,
    output: `${rendered}\n[whole notebook read; offset/limit do not apply — use NotebookEdit with a cell index to change cells]`,
  };
}
