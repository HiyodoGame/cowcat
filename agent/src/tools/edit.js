// Edit tool: exact string replacement. Requires the file to have been read first.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const EditTool = {
  name: 'Edit',
  description: `Replace an exact string in a file with another string. This is the tool for changing existing code.

How it works: old_string must match the file character for character, including indentation. The replacement is exact — it does not understand syntax, only text.
When to use: targeted changes to existing files — fixing a line, updating an expression, renaming across one occurrence, inserting a block next to known content.
When NOT to use: creating new files or rewriting most of a file (use Write instead), or applying large multi-hunk patches (make several small Edits).
Rules the tool enforces, and why:
- You must Read the file earlier in this session first. Editing blind corrupts files.
- old_string must occur exactly once. If it appears multiple times, either include more surrounding context so it becomes unique, or pass replace_all: true when you genuinely mean every occurrence (renames, import updates).
- old_string and new_string must differ.
Failure modes: a not-found old_string usually means you guessed the content instead of reading it — re-read the exact region and copy it verbatim rather than retyping from memory. Non-unique matches need more context, not a retry of the same call.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to edit' },
      old_string: { type: 'string', description: 'Exact text to replace; must be unique in the file unless replace_all' },
      new_string: { type: 'string', description: 'Replacement text; must differ from old_string' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.file_path);
    if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    if (!ctx.readSet.has(filePath)) {
      return { ok: false, error: `File has not been read yet in this session. Read ${filePath} before editing it.` };
    }
    if (input.old_string === input.new_string) {
      return { ok: false, error: 'old_string and new_string are identical; nothing to change' };
    }
    const content = readFileSync(filePath, 'utf8');
    const occurrences = content.split(input.old_string).length - 1;
    if (occurrences === 0) {
      return { ok: false, error: `old_string not found in ${filePath}. It must match the file content exactly.` };
    }
    if (occurrences > 1 && !input.replace_all) {
      return { ok: false, error: `old_string is not unique in ${filePath} (${occurrences} matches). Narrow it down or set replace_all=true.` };
    }
    const next = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);
    writeFileSync(filePath, next);
    return { ok: true, output: `Edited ${filePath} (${input.replace_all ? occurrences : 1} replacement${occurrences > 1 ? 's' : ''})` };
  },
};
