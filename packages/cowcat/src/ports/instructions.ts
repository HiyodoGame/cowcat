// InstructionPort — reading the project's own instructions (ADR-076).
//
// The file is `AGENTS.md`: an open format used by 60k+ projects and stewarded by the
// Agentic AI Foundation, with `CLAUDE.md` kept as a compatibility fallback. The
// legacy implementation looked for a proprietary `COWCAT.md` FIRST, so a repository
// that wrote the standard file had it silently ignored (agent/src/project.js:6).
//
// This is a port rather than a plain function because reading a file is host work; which
// files win, how they are rendered, and whether they may be injected at all are decisions
// that live in policy (policy/instructions.ts) where they can be tested without a filesystem.

export interface InstructionFile {
  /** The filename it was found under, e.g. `AGENTS.md`. */
  readonly name: string;
  /** Absolute path, as found. */
  readonly path: string;
  readonly content: string;
}

export interface InstructionChainOptions {
  /**
   * A user-global file read before the project chain (ADR-075), e.g. `~/.cowcat/AGENTS.md`.
   * Absent or unreadable contributes nothing.
   */
  readonly global?: string;
}

export interface InstructionPort {
  /**
   * The instruction chain that applies to `cwd`, **broad to specific** (ADR-076).
   *
   * The chain runs from the project root (the directory with `.git`) down to `cwd`, one
   * base file per directory (`AGENTS.md`, else `CLAUDE.md`) plus that directory's local
   * overlay. A directory with nothing in it contributes nothing, and an empty file does
   * not count — an accidentally created empty `AGENTS.md` must not shadow a populated
   * `CLAUDE.md` beside it.
   *
   * Outside a repository the chain is just `cwd`. A path that cannot be read
   * contributes nothing rather than failing the walk: instructions are guidance, and a
   * session that refuses to start over a broken file would be worse than one that says
   * afterwards what it did not load.
   */
  chain(cwd: string, options?: InstructionChainOptions): Promise<readonly InstructionFile[]>;
}
