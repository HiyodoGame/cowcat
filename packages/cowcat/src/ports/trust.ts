// TrustStore — where "this directory has been trusted" is remembered (ADR-025
// decision 3, ADR-028).
//
// Deliberately its own port and its own file, not a key in the configuration. The
// legacy implementation kept trust inside the same object as the settings and then
// re-applied that object as the highest-priority config layer, which is how a
// project's committed configuration could be silently discarded by the user's own
// state file. Trust is a fact about a directory, not a setting, and the two never
// merge.
//
// A store holds CANONICAL paths (ADR-017): identity, not spelling. The legacy code
// compared spellings and lost seven macOS tests to `/var` vs `/private/var`.

export interface TrustSnapshot {
  /** Canonical paths. Empty when nothing is trusted, and empty when the store cannot be read. */
  readonly trusted: readonly string[];
  /**
   * Non-null when the store exists but could not be read.
   *
   * The list is empty in that case, which means "untrusted" — the safe direction to
   * fail in, since untrusted only ever takes permissions away. It is still reported
   * rather than swallowed: silently resetting a user's trust and saying nothing is
   * the kind of quiet that costs an afternoon.
   */
  readonly problem: string | null;
}

export interface TrustStore {
  /** Never throws: an unreadable store is an empty list plus a `problem`. */
  load(): Promise<TrustSnapshot>;

  /**
   * Records a canonical path. Idempotent by identity, so trusting the same
   * directory twice — or through two spellings of it — adds one entry.
   *
   * Throws if the record cannot be written. The difference from `load` is
   * deliberate: reading nothing is a safe default, while a user who asked to trust
   * a directory and was not told the write failed believes something untrue.
   */
  add(path: string): Promise<void>;

  /**
   * Drops a canonical path. Returns whether an entry was actually removed.
   *
   * Reversible on purpose: trust is granted to run a repository's own rules, and a
   * grant that cannot be withdrawn without hand-editing a JSON file is a grant people
   * leave in place.
   */
  remove(path: string): Promise<boolean>;
}
