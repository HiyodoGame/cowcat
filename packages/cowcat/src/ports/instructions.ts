// InstructionPort — reading the project's own instructions (ADR-029).
//
// The file is `AGENTS.md`: an open format used by 60k+ projects and stewarded by the
// Agentic AI Foundation, with `CLAUDE.md` kept as a compatibility fallback. The
// legacy implementation looked for a proprietary `COWCAT.md` FIRST, so a repository
// that wrote the standard file had it silently ignored (agent/src/project.js:6).
//
// This is a port rather than a plain function because reading a file is host work;
// which file wins, and whether it may be injected at all, are decisions that live in
// policy (policy/instructions.ts) where they can be tested without a filesystem.

export interface InstructionFile {
  /** The filename it was found under, e.g. `AGENTS.md`. */
  readonly name: string;
  /** Absolute path, as found. */
  readonly path: string;
  readonly content: string;
}

export interface InstructionPort {
  /**
   * The nearest instruction file at or above `cwd`, or null when there is none.
   *
   * "Nearest" is the standard's rule — the closest file wins. A file that exists but
   * is empty does not count, so an accidental empty `AGENTS.md` cannot shadow a
   * populated `CLAUDE.md` beside it.
   */
  nearest(cwd: string): Promise<InstructionFile | null>;
}
