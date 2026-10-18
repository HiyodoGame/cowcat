import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

export interface EditToolOptions {
  /** The working directory a relative `file_path` is resolved against. */
  readonly cwd: string;
}

const DESCRIPTION = [
  'Replace an exact string in a file with another string. This is the tool for changing existing code.',
  '',
  'How it works: old_string must match the file character for character, including indentation. The replacement is exact — it does not understand syntax, only text.',
  'When to use: targeted changes to existing files — fixing a line, updating an expression, renaming across one occurrence, inserting a block next to known content.',
  'When NOT to use: creating new files or rewriting most of a file (use Write instead), or applying large multi-hunk patches (make several small Edits).',
  'Rules the tool enforces, and why:',
  '- You must Read the file earlier in this session first. Editing blind corrupts files. The rule is derived from the log, so it still holds after a session is reopened.',
  '- old_string must occur exactly once. If it appears multiple times, either include more surrounding context so it becomes unique, or pass replace_all: true when you genuinely mean every occurrence (renames, import updates).',
  '- old_string and new_string must differ, and old_string must not be empty.',
  'Failure modes: a not-found old_string usually means you guessed the content instead of reading it — re-read the exact region and copy it verbatim rather than retyping from memory. On a CRLF file the carriage returns are part of the text, and the error says so. Non-unique matches need more context, not a retry of the same call.',
].join('\n');

export function createEditTool(options: EditToolOptions): ToolPort {
  return defineTool(
    {
      name: 'Edit',
      description: DESCRIPTION,
      risk: 'write',
      pathInput: 'file_path',
      input: z.object({
        file_path: z.string().describe('Path of the file to edit'),
        old_string: z.string().describe('Exact text to replace; must be unique in the file unless replace_all'),
        new_string: z.string().describe('Replacement text; must differ from old_string'),
        replace_all: z.boolean().optional().describe('Replace every occurrence instead of exactly one'),
      }),
    },
    (input) => {
      const filePath = resolve(options.cwd, input.file_path);
      let content: string;
      try {
        if (statSync(filePath).isDirectory()) return { ok: false, output: `${filePath} is a directory, not a file` };
        content = readFileSync(filePath, 'utf8');
      } catch {
        return { ok: false, output: `file not found: ${filePath}` };
      }

      if (input.old_string === input.new_string) {
        return { ok: false, output: 'old_string and new_string are identical; nothing to change' };
      }
      // Not in v1, and it matters: `split('')` inserts the replacement between every
      // character, which is never what the caller meant (research §6.4).
      if (input.old_string === '') {
        return { ok: false, output: 'old_string must not be empty: use Write to create content or give the text to insert' };
      }

      const occurrences = content.split(input.old_string).length - 1;
      if (occurrences === 0) {
        // The legacy message sent the model looking for a content mistake. On a CRLF
        // file the most likely mistake is the line endings, which are invisible in what
        // Read returned (research §6.2) — name it instead of guessing silently.
        const crlfHint =
          content.includes('\r\n') && !input.old_string.includes('\r')
            ? ' The file uses CRLF line endings, so old_string must include the carriage returns — copy the text from Read verbatim.'
            : '';
        return {
          ok: false,
          output: `old_string not found in ${filePath}; it must match the file exactly, including indentation and whitespace.${crlfHint}`,
        };
      }
      if (occurrences > 1 && input.replace_all !== true) {
        return {
          ok: false,
          output: `old_string is not unique in ${filePath} (${String(occurrences)} matches). Add surrounding context, or set replace_all=true.`,
        };
      }

      const next =
        input.replace_all === true
          ? content.split(input.old_string).join(input.new_string)
          : content.replace(input.old_string, input.new_string);
      try {
        writeFileSync(filePath, next);
      } catch (error) {
        return { ok: false, output: `cannot write ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
      }

      const replaced = input.replace_all === true ? occurrences : 1;
      return {
        ok: true,
        output: `edited ${filePath} (${String(replaced)} replacement${replaced === 1 ? '' : 's'})`,
        truncation: { truncated: false, dropped: 0, reason: null },
      };
    },
  );
}
