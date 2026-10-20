import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { INSTRUCTION_FILENAMES, LOCAL_INSTRUCTION_FILENAMES } from '../policy/instructions.js';
import type { FsPort, InstructionChainOptions, InstructionFile, InstructionPort } from '../ports/index.js';

export interface FileInstructionSourceOptions {
  /** Path identity (ADR-017), used to canonicalise the directory the walk starts at. */
  readonly fs: FsPort;
}

/**
 * Reads the instruction chain that applies to a directory (ADR-076).
 *
 * Three details are load-bearing:
 *
 *   * the walk starts at `fs.canonical(cwd)`, so `/var/x` and `/private/var/x` walk the
 *     same directories. The legacy code was bitten by exactly this (7 macOS CI failures,
 *     docs/fix-plan-2026-10-15.md round 19);
 *   * the chain stops at the **project root** — the first directory that carries `.git`
 *     — so a checkout inside someone's home directory does not pick up their personal
 *     rules from three levels above. Outside a repository the chain is just `cwd`;
 *   * an existing but EMPTY file is skipped. Otherwise an accidentally created empty
 *     `AGENTS.md` would shadow a populated `CLAUDE.md` next to it.
 */
export class FileInstructionSource implements InstructionPort {
  readonly #fs: FsPort;

  constructor(options: FileInstructionSourceOptions) {
    this.#fs = options.fs;
  }

  async chain(cwd: string, options: InstructionChainOptions = {}): Promise<readonly InstructionFile[]> {
    const dirs: string[] = [];
    let dir = this.#fs.canonical(cwd);
    for (;;) {
      dirs.push(dir);
      // `.git` is a directory in a normal checkout and a file in a worktree; `exists`
      // does not care which, and neither should the walk.
      if (this.#fs.exists(join(dir, '.git'))) break;
      const parent = dirname(dir);
      // dirname of a root is itself, which is how the walk ends on both platforms.
      if (parent === dir || parent === '') break;
      dir = parent;
    }

    const out: InstructionFile[] = [];
    // The user-global file first: it is the broadest scope there is (ADR-075).
    const global = options.global === undefined ? null : await readOne(options.global);
    if (global !== null) out.push(global);
    // Broad to specific: the root first, so the most local rules are read last.
    for (const directory of dirs.reverse()) {
      const base = await first(directory, INSTRUCTION_FILENAMES);
      if (base !== null) out.push(base);
      const local = await first(directory, LOCAL_INSTRUCTION_FILENAMES);
      if (local !== null) out.push(local);
    }
    return out;
  }
}

// One explicitly named file, by absolute path; the name is its basename.
async function readOne(path: string): Promise<InstructionFile | null> {
  const content = await readText(path);
  if (content === null) return null;
  const trimmed = content.trim();
  if (trimmed === '') return null;
  return { name: basename(path), path, content: trimmed };
}

// The first candidate that exists, reads, and is not empty. A directory listed as a
// candidate name, or a file that vanished between the exists() check and the read, is
// "not an instruction file" rather than an error.
async function first(directory: string, names: readonly string[]): Promise<InstructionFile | null> {
  for (const name of names) {
    const path = join(directory, name);
    const content = await readText(path);
    if (content === null) continue;
    const trimmed = content.trim();
    if (trimmed === '') continue;
    return { name, path, content: trimmed };
  }
  return null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
