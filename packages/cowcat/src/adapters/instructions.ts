import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { INSTRUCTION_FILENAMES } from '../policy/instructions.js';
import type { FsPort, InstructionFile, InstructionPort } from '../ports/index.js';

export interface FileInstructionSourceOptions {
  /** Path identity (ADR-017), used to canonicalise the directory the walk starts at. */
  readonly fs: FsPort;
}

/**
 * Walks up from `cwd` looking for the nearest instruction file.
 *
 * Two details are load-bearing:
 *
 *   * the walk starts at `fs.canonical(cwd)`, so `/var/x` and `/private/var/x` walk
 *     the same directories. The legacy code was bitten by exactly this (7 macOS CI
 *     failures, docs/fix-plan-2026-10-15.md round 19), and the standard's own
 *     migration advice is to use a symlink — which is the same hazard again;
 *   * an existing but EMPTY file is skipped. Otherwise an accidentally created empty
 *     `AGENTS.md` would shadow a populated `CLAUDE.md` next to it.
 */
export class FileInstructionSource implements InstructionPort {
  readonly #fs: FsPort;

  constructor(options: FileInstructionSourceOptions) {
    this.#fs = options.fs;
  }

  async nearest(cwd: string): Promise<InstructionFile | null> {
    let dir = this.#fs.canonical(cwd);
    for (;;) {
      for (const name of INSTRUCTION_FILENAMES) {
        const path = join(dir, name);
        if (!this.#fs.exists(path)) continue;
        const content = await readText(path);
        if (content === null) continue;
        const trimmed = content.trim();
        if (trimmed === '') continue;
        return { name, path, content: trimmed };
      }
      const parent = dirname(dir);
      // dirname of a root is itself, which is how the walk ends on both platforms.
      if (parent === dir || parent === '') return null;
      dir = parent;
    }
  }
}

// A directory listed as a candidate filename, or a file that vanished between the
// exists() check and the read, is "not an instruction file" rather than an error.
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
