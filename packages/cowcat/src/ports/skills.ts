// SkillPort — discovering local `SKILL.md` files (ADR-114).
//
// The port returns what was found and what was skipped, never throws. Reading is host
// work; which layer wins, whether the workspace is trusted enough to see its own skills,
// and how many bytes the catalog may cost are decisions that live in `policy/skills.ts`
// where they are testable without a filesystem (the same split ADR-076 made for
// instructions).

/** Which scope a skill came from. Trust applies to `project` only (ADR-114 ③). */
export type SkillLayer = 'user' | 'project';

/**
 * Which directory convention it came from.
 *
 * `cowcat` is ours; `claude` is the read-only compatibility location. The distinction is
 * load-bearing twice: precedence (`.cowcat` wins on a name clash) and `doctor`, which has
 * to say where a skill was read from.
 */
export type SkillOrigin = 'cowcat' | 'claude';

export interface SkillFile {
  /** The frontmatter name, or the directory name when the field was omitted. */
  readonly name: string;
  /** One line, already truncated to the spec's 1024-character ceiling. */
  readonly description: string;
  /** Absolute path of the `SKILL.md` that was read. */
  readonly path: string;
  /** Absolute directory holding it; every bundled path is relative to this. */
  readonly root: string;
  readonly layer: SkillLayer;
  readonly origin: SkillOrigin;
  /** The Markdown after the frontmatter, trimmed. Held in memory: discovery read it anyway. */
  readonly body: string;
  /**
   * Frontmatter keys that were parsed but are not honoured (ADR-115 ①). Reported by
   * `doctor` rather than ignored in silence, so an author does not believe a grant is in
   * force when it is not.
   */
  readonly ignoredFields: readonly string[];
  /**
   * Claude Code's `disable-model-invocation: true`. The skill is left out of the catalog
   * and cannot be loaded through the tool (ADR-117 ⑤) — a tightening, so it is honoured.
   */
  readonly hidden: boolean;
}

export interface SkillDiscovery {
  /** Everything that parsed, in directory-walk order; precedence is decided by policy. */
  readonly skills: readonly SkillFile[];
  /**
   * One line per candidate that was present but unusable, plus one per project directory
   * that was withheld. Ready to print: the adapter owns the wording because it is the
   * only layer that knows the path.
   */
  readonly warnings: readonly string[];
}

export interface SkillPort {
  /**
   * The skills visible from `cwd`, plus why any candidate was dropped.
   *
   * Runs from the personal directories and the project root only. A directory that cannot
   * be read contributes nothing rather than failing the session: a broken skill folder is
   * not a reason to refuse to start (the rule ADR-076 set for instruction files).
   */
  discover(cwd: string): Promise<SkillDiscovery>;
}
