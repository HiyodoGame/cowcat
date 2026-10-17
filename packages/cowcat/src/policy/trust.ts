import type { Rule } from './decide.js';
import type { CowcatConfig } from './config.js';

/**
 * Whether the workspace this session runs in has been trusted.
 *
 * A fact about a directory, not a setting: it is decided once per session from the
 * trust store and never merged as configuration (ADR-025 decision 3). The legacy
 * implementation kept it in the same object as the settings and applied it as the
 * highest-priority layer, which is how a project's own configuration could be
 * silently discarded.
 */
export interface TrustState {
  readonly trusted: boolean;
}

/**
 * The rules that actually apply, given whether the workspace is trusted (ADR-028).
 *
 * Untrusted means `deny` and `ask` stand and `allow` does not — the asymmetry is
 * the point: **tightening never needs authorisation, loosening does**. A workspace
 * you have not trusted can still be refused and still be questioned; it cannot
 * hand itself permissions.
 *
 * A note on scope, because ADR-028 did not pin it down and the literal reading is
 * unusable. "No allow rule applies while untrusted" would also drop the built-in
 * `reads-are-free`, making every file read prompt — an agent nobody would run. The
 * external model ADR-028 cites gates by SOURCE instead: an allow in a repository
 * file waits for trust, the user's own allowances do not. So:
 *
 *   default  the product's own baseline — not the workspace's to grant  → never gated
 *   user     your machine-wide choice — yours, not the repository's      → never gated
 *   project  the repository's file — this is the thing being trusted      → GATED
 *   session  chosen explicitly for this run                              → never gated
 *
 * Only `allow` is gated. A project's `deny` or `ask` takes effect immediately,
 * which is why an untrusted checkout can still be constrained by a file in it.
 */
export function trustedRules(config: CowcatConfig, trust: TrustState): readonly Rule[] {
  return config.rules
    .filter((sourced) => trust.trusted || sourced.origin !== 'project' || sourced.rule.verdict !== 'allow')
    .map((sourced) => sourced.rule);
}
