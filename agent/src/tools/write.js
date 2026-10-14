// Write tool: create or fully overwrite a file. Existing files must be read first.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const WriteTool = {
  name: 'Write',
  description: `Write content to a file, creating it (and missing parent directories) or overwriting it completely.

When to use: new files — new modules, configs, fixtures — or the rare full rewrite where nearly every line changes and an Edit series would be more error-prone.
When NOT to use: small changes to existing files (use Edit). Overwriting a large file to change one line destroys everything you were not looking at.
Rule the tool enforces: if the file already exists, it must have been read in this session before the overwrite is allowed. Read first, then Write.
Failure modes: writing to a path that turns out to exist (and was never read) fails by design — read the current content, then decide whether Write or Edit is the right tool. Overly broad rewrites are a habit to avoid, not an error the tool can catch.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to write' },
      content: { type: 'string', description: 'Full new content of the file' },
    },
    required: ['file_path', 'content'],
  },
  execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.file_path);
    const existed = existsSync(filePath);
    if (existed && !ctx.readSet.has(filePath)) {
      return { ok: false, error: `File exists but has not been read yet in this session. Read ${filePath} before overwriting it.` };
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, input.content);
    ctx.readSet.add(filePath);
    return { ok: true, output: `${existed ? 'Updated' : 'Created'} ${filePath} (${input.content.length} chars)` };
  },
};
