// The View tool (ADR-138): eyes for a text-only model. It reads a local image and
// asks the user's configured vision preset — default `zai/glm-4v-flash` — to describe
// it / OCR it, and returns the text answer to the conversation. A multimodal main
// preset does not need this: it reads images natively through the attachment path
// (ADR-057). The image bytes go to the vision endpoint, never into the session log
// (the ToolResult carries text only, ADR-139 ③).

import { existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import type { Attachment, ModelPort, ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

export interface ViewToolOptions {
  /** Working directory a relative `path` resolves against. */
  readonly cwd: string;
  /**
   * Lazily resolve the vision endpoint. Throwing here (unknown preset, missing key)
   * is the contract: the tool turns it into a refusal with the guidance, and createHost
   * is never affected (ADR-138 ③).
   */
  readonly vision: () => { readonly port: ModelPort; readonly model: string };
}

// ADR-058's 5MB口径, same as the attachment path it rides.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Vision answers are prose; past 16KB the conversation is being fed a transcript,
// which is what Read is for.
const OUTPUT_MAX_CHARS = 16 * 1024;

const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const DEFAULT_PROMPT = 'Describe this image in detail: its content and structure, and transcribe ALL text in it (OCR). Preserve the original language of any text you find.';

const DESCRIPTION = [
  'Look at an image file and answer a question about it, using a vision-capable model configured by the user. The answer comes back as text.',
  '',
  'When to use: the session model is text-only and you need what is IN an image — a screenshot of an error, a diagram, a photo of a whiteboard, text that only exists as pixels.',
  'When NOT to use: the session model is multimodal (then Read the image directly — it sees the picture, this tool would only describe it). Text files. PDFs (Read handles those).',
  '',
  'The image bytes are sent to the vision endpoint the user configured (default zai/glm-4v-flash). Sizes over 5MB and non-image files are refused.',
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
      const mediaType = MEDIA_BY_EXTENSION[extname(filePath).toLowerCase()];
      if (mediaType === undefined) {
        return {
          ok: false,
          output: `refused: ${filePath} is not a supported image (png/jpeg/gif/webp/bmp); PDFs and other documents are Read's job`,
        };
      }
      const size = statSync(filePath).size;
      if (size > IMAGE_MAX_BYTES) {
        return { ok: false, output: `refused: ${filePath} is ${String(size)} bytes, past the ${String(IMAGE_MAX_BYTES)} image ceiling` };
      }
      if (size === 0) {
        return { ok: false, output: `refused: ${filePath} is empty` };
      }

      let vision: { readonly port: ModelPort; readonly model: string };
      try {
        vision = options.vision();
      } catch (error) {
        const detail = error as { readonly message?: string; readonly guidance?: string };
        return {
          ok: false,
          output: [
            `the vision endpoint is not available: ${detail.message ?? String(error)}`,
            detail.guidance === undefined ? '' : detail.guidance,
            'The View tool needs a vision-capable preset: set "vision": "<preset-id>" in your user config (default zai/glm-4v-flash), or run cowcat doctor to list presets.',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        };
      }

      const image: Attachment = { type: 'image', mediaType, path: filePath, bytes: size, width: null, height: null, pages: null };
      let text = '';
      try {
        for await (const chunk of vision.port.stream(
          {
            messages: [{ role: 'user', text: input.prompt ?? DEFAULT_PROMPT }],
            tools: [],
            model: vision.model,
            images: [image],
          },
          signal,
        )) {
          if (chunk.type === 'text') text += chunk.text;
          if (text.length > OUTPUT_MAX_CHARS) break;
        }
      } catch (error) {
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
