// FsPort — path identity (ADR-017).
//
// Every place that treats a path as an ID has to agree on what the path IS, not
// how it happens to be spelled. The legacy code got this wrong in a way that only
// showed up on macOS: `os.tmpdir()` returns `/var/folders/...` while
// `process.cwd()` returns the physical `/private/var/folders/...`, and trust
// records compared paths with `===`. Seven unrelated tests failed on the first
// macOS CI run (docs/fix-plan-2026-10-15.md, round 19) — trust keys, session
// slugs, todo files, plan mode. All of it was one missing canonicalisation.
//
// So: one implementation, called from everywhere a path becomes a key. The rules
// it must honour come from agent/src/canonical.js, which is what P2 migrates:
//
//   * resolve symlinks (`realpath`), collapse `.`/`..` and relative segments;
//   * a path that does not exist yet still gets an identity — resolve the
//     DEEPEST EXISTING ancestor and re-attach the missing tail;
//   * never throw. A broken sandbox policy must not become a crash in the tool
//     path (the legacy threat model's fail-open rule, see src/sandbox.js);
//   * report the filesystem's own case, and treat "same path" as identity.
//
// Deliberately synchronous. These calls sit inside pure argv generation (the
// sandbox builders take a resolved policy and return a command line), and making
// them async would force the policy resolver to become async and the builders to
// stop being pure. A synchronous FS probe is also what the legacy backends were
// built around, which is why their policy→argv mapping is unit-testable on
// Windows where /usr does not exist.

export type FileKind = 'file' | 'directory' | 'other';

export interface FsPort {
  /**
   * The one spelling of a path that means "this directory": symlinks resolved,
   * relative segments collapsed, case as the filesystem reports it. Returns the
   * input unchanged for non-strings and the empty string; never throws.
   */
  canonical(path: string): string;

  /** Identity comparison. `samePath(a, b)` is the only correct way to compare two paths. */
  samePath(a: string, b: string): boolean;

  /** What a path is, or null when it does not exist / cannot be read. Never throws. */
  kindOf(path: string): FileKind | null;

  /** Whether a path exists at all, symlinks followed. Never throws. */
  exists(path: string): boolean;
}

/**
 * A pure policy resolver for paths, shared by every backend. Kept here (not in an
 * adapter) because it decides what a policy MEANS; the adapter only asks the
 * filesystem what is true. The legacy resolver lives in
 * agent/src/sandbox/policy.js and is migrated as-is in the P2 adapter task.
 */
export interface PathPolicyResolver {
  /** Absolute, canonical, literal paths. Globs are rejected rather than ignored. */
  resolve(entries: readonly string[], cwd: string): { readonly resolved: readonly string[]; readonly unsupported: readonly string[] };
}