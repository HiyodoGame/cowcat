// The View tool (ADR-138): eyes for a text-only model. It reads a local image and
// asks the user's configured vision preset — default `zai/glm-4v-flash` — to describe
// it / OCR it, and returns the text answer to the conversation. A multimodal main
// preset does not need this: it reads images natively through the attachment path
// (ADR-057). The image bytes go to the vision endpoint, never into the session log
// (the ToolResult carries text only, ADR-139 ③).
//
// The image kind is decided by sniffing the bytes, not the extension — the same
// discipline Read documents in imageinfo.ts ("the name is the model's claim; the
// magic is the fact"). This matters more here than for Read: View's bytes leave the
// machine for a third-party endpoint, and `reads-are-free` means no approval stands
// in between.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { sniffBuffer } from '../imageinfo.js';
import { makeAttachment } from '../../ports/attachments.js';
import type { ModelPort, ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

export interface ViewToolOptions {
  /** Working directory a relative `path` resolves against. */
  readonly cwd: string;
  /**
   * Lazily resolve the vision endpoint. Throwing here (unknown preset, missing key)
   * is the contract: the tool turns it into a refusal with the guidance, and createHost
   * is never affected (ADR-138 ③).
   */
  readonly vision: () => { readonly port: ModelPort; readonly model: string; readonly maxTokens?: number | undefined };
}

// ADR-058's 5MB口径, same as the attachment path it rides.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Vision answers are prose; past 16KB the conversation is being fed a transcript,
// which is what Read is for.
const OUTPUT_MAX_CHARS = 16 * 1024;

const DEFAULT_PROMPT =
  'Describe this image in detail: its content and structure, and transcribe ALL text in it (OCR). Preserve the original language of any text you find.';

const DESCRIPTION = [
  'Look at an image file and answer a question about it, using a vision-capable model configured by the user. The answer comes back as text.',
  '',
  'When to use: the session model is text-only and you need what is IN an image — a screenshot of an error, a diagram, a photo of a whiteboard, text that only exists as pixels.',
  'When NOT to use: the session model is multimodal (then Read the image directly — it sees the picture, this tool would only describe it). Text files. PDFs (Read handles those).',
  '',
  'The image bytes are sent to the vision endpoint the user configured (default zai/glm-4v-flash). Files over 5MB and non-image files (checked by content, not by name) are refused.',
  'With no `prompt`, the tool describes the image and transcribes all text (OCR). Pass a `prompt` to ask something specific instead.',
].join('\n');

const inputSchema = z
  .object({
    path: z.string().min(1).describe('Path of the image file (relative to the working directory or absolute)'),
    prompt: z.string().min(1).optional().describe('What to ask about the image; default describes it and OCRs all text'),
  })
  .strict();

export function createViewTool(options: ViewToolOptions): ToolPort {
  return defineTool(
    {
      name: 'View',
      description: DESCRIPTION,
      risk: 'read',
      pathInput: 'path',
      input: inputSchema,
    },
    async (input, signal) => {
      const filePath = resolve(options.cwd, input.path);
      if (!existsSync(filePath)) {
        return { ok: false, output: `no such file: ${filePath}` };
      }
      if (!statSync(filePath).isFile()) {
        return { ok: false, output: `refused: ${filePath} is not a regular file` };
      }
      // The 5MB gate runs on the bytes actually read, not the stat: a file swapped or
      // grown between check and read is caught at the size that matters (review of
      // #198, P2-1). The wire-time re-read is still bounded by the attachment hard
      // limit, so the residual TOCTOU window cannot pass 20MB on this protocol.
      const buffer = readFileSync(filePath);
      if (buffer.byteLength > IMAGE_MAX_BYTES) {
        return { ok: false, output: `refused: ${filePath} is ${String(buffer.byteLength)} bytes, past the ${String(IMAGE_MAX_BYTES)} image ceiling` };
      }
      if (buffer.byteLength === 0) {
        return { ok: false, output: `refused: ${filePath} is empty` };
      }
      const sniffed = sniffBuffer(buffer);
      // Explicit negative checks rather than the isImageKind guard: === narrowing
      // discriminates the Sniffed union, which is what makes mediaType/width/height
      // reachable below.
      if (sniffed.kind === 'pdf' || sniffed.kind === 'image-unsupported' || sniffed.kind === 'text' || sniffed.kind === 'binary') {
        const claim =
          sniffed.kind === 'image-unsupported'
            ? `an unsupported image format (${sniffed.format})`
            : sniffed.kind === 'pdf'
              ? 'a PDF (Read handles documents)'
              : sniffed.kind === 'text'
                ? 'text'
                : 'binary data';
        return {
          ok: false,
          output: `refused: ${filePath} is ${claim} by its bytes, not an image View can send — the name says ${extname(filePath) || '(none)'}, the content decides, and rename-to-.png does not make a file an image.`,
        };
      }

      let vision: { readonly port: ModelPort; readonly model: string; readonly maxTokens?: number | undefined };
      try {
        vision = options.vision();
      } catch (error) {
        const detail = error as { readonly message?: string; readonly hint?: string };
        return {
          ok: false,
          output: [
            `the vision endpoint is not available: ${detail.message ?? String(error)}`,
            detail.hint === undefined ? '' : detail.hint,
            'The View tool needs a vision-capable preset: set "vision": "<preset-id>" in your user config (cowcat doctor lists the built-in ids).',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        };
      }

      const image = makeAttachment({
        type: 'image',
        mediaType: sniffed.mediaType,
        path: filePath,
        bytes: buffer.byteLength,
        width: sniffed.width,
        height: sniffed.height,
      });
      let text = '';
      try {
        for await (const chunk of vision.port.stream(
          {
            messages: [{ role: 'user', text: input.prompt ?? DEFAULT_PROMPT }],
            tools: [],
            model: vision.model,
            ...(vision.maxTokens === undefined ? {} : { maxTokens: vision.maxTokens }),
            images: [image],
          },
          signal,
        )) {
          if (chunk.type === 'text') text += chunk.text;
          if (text.length > OUTPUT_MAX_CHARS) break;
        }
      } catch (error) {
        // A cancellation is not a tool failure: rethrow so the turn ends the way the
        // user asked, instead of logging a fake "vision call failed" (review of #198,
        // P2-3 — the run-turn convention).
        if (signal.aborted) throw error;
        return { ok: false, output: `vision call failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (text.trim() === '') {
        return { ok: false, output: 'the vision model returned no text' };
      }
      const truncated = text.length > OUTPUT_MAX_CHARS;
      return {
        ok: true,
        output: truncated ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n[truncated: vision answer exceeded ${String(OUTPUT_MAX_CHARS)} chars]` : text,
        truncation: { truncated, dropped: 0, reason: truncated ? `vision answer cap ${String(OUTPUT_MAX_CHARS)}` : null },
      };
    },
  );
}
