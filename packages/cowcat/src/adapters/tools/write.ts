import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

export interface WriteToolOptions {
  /** The working directory a relative `file_path` is resolved against. */
  readonly cwd: string;
}

const DESCRIPTION = [
  'Write content to a file, creating it (and missing parent directories) or overwriting it completely.',
  '',
  'When to use: new files — new modules, configs, fixtures — or the rare full rewrite where nearly every line changes and an Edit series would be more error-prone.',
  'When NOT to use: small changes to existing files (use Edit). Overwriting a large file to change one line destroys everything you were not looking at.',
  'Rule the kernel enforces: if the file already exists, it must have been read in this session before the overwrite is allowed. Read first, then Write. The rule is derived from the log, so it still holds after a session is reopened.',
  'Failure modes: writing to a path that turns out to exist (and was never read) fails by design — read the current content, then decide whether Write or Edit is the right tool. Overly broad rewrites are a habit to avoid, not an error the tool can catch.',
].join('\n');

export function createWriteTool(options: WriteToolOptions): ToolPort {
  return defineTool(
    {
      name: 'Write',
      description: DESCRIPTION,
      risk: 'write',
      pathInput: 'file_path',
      input: z.object({
        file_path: z.string().describe('Path of the file to write'),
        content: z.string().describe('Full new content of the file'),
      }),
    },
    (input) => {
      const filePath = resolve(options.cwd, input.file_path);
      const existed = existsSync(filePath);
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, input.content);
      } catch (error) {
        return { ok: false, output: `cannot write ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
      }
      return {
        ok: true,
        output: `${existed ? 'updated' : 'created'} ${filePath} (${String(input.content.length)} chars)`,
        truncation: { truncated: false, dropped: 0, reason: null },
      };
    },
  );
}
