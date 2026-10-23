import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AttachedFile } from '../kernel/events.js';

/**
 * `@` prompt file references (ADR-128): the host validates and reads them here — the
 * host layer is barred from `node:*` file operations (ADR-014/017) just like the
 * kernel, and `FsPort` is an identity port with no read.
 */

export const PROMPT_FILE_MAX_BYTES = 32 * 1024;
/** The wire caps a send at 8 references (protocol/methods.ts); the host double-checks. */
export const PROMPT_FILE_MAX_COUNT = 8;

/** Why one file was refused; the message a person needs is the path, which the host adds. */
export class PromptFileError extends Error {}

/**
 * Read one `@` reference the way ADR-128 promises: absolute, present, UTF-8 text,
 * capped. Throws {@link PromptFileError} with a short `why` — never half-reads.
 */
export async function readPromptFile(path: string): Promise<AttachedFile> {
  if (!isAbsolute(path)) throw new PromptFileError('必须是绝对路径');
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    throw new PromptFileError('读不到（不存在或不可读）');
  }
  if (raw.length > PROMPT_FILE_MAX_BYTES) {
    throw new PromptFileError(`${String(raw.length)} 字节，超出 ${String(PROMPT_FILE_MAX_BYTES)} 字节上限`);
  }
  try {
    // The name is the path as given, not basename: two same-named files from different
    // directories must stay distinguishable in the model's context (review of #173, P2-12).
    return { name: path, content: new TextDecoder('utf-8', { fatal: true }).decode(raw) };
  } catch {
    throw new PromptFileError('不是 UTF-8 文本');
  }
}
