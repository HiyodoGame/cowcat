// Environment redaction — the rule set, as a pure function (ADR-015).
//
// This lives in policy/ rather than in the Node adapter on purpose: it decides
// what a child environment is ALLOWED to contain, which is a policy question, not
// a runtime question. The adapter applies the result; nothing here knows that
// processes or filesystems exist.
//
// Scope correction over the legacy implementation, and the reason this file
// exists at all: in `agent/`, redaction ran only on the Bash tool's `light` path.
// `sandboxEnv()` returns the environment untouched when `mode !== 'light'`, so
// the `system` tier did NOT redact, and `background.js` re-expanded
// `...process.env` on top of the already-redacted env, putting the stripped keys
// straight back. MCP stdio, hooks, statusline, git calls and the TUI `!` shell
// never redacted at all (research/p2-ports.md §4.2). Nine paths, one covered.
//
// The rule set itself is kept as-is, because it is tested and each entry has a
// stated reason. Only the coverage and the reporting change:
//
//   * the gateway applies it for `light` AND `system` (never for `off`, which is
//     the one mode whose contract is "run the command as-is");
//   * the names that were removed come back in the result, so "what did the child
//     not see" is a fact the caller can log instead of a claim it cannot check.
//
// Names only. Values never leave this function: a stripped variable's value is
// exactly the thing that must not travel any further.

/**
 * Kept even if a name ever matches the credential pattern (none of them do
 * today). Each entry exists because dropping it breaks something:
 *
 *   PATH/PATHEXT/COMSPEC   nothing spawns on Windows without them
 *   SystemRoot/WINDIR/...  DLL and loader lookups; children die without them
 *   HOME/USERPROFILE/...   too many tools assume a home directory exists
 *   TEMP/TMP               compilers and installers write scratch files there
 *   LANG/LC_ALL/...        keeps tool output decodable; harmless
 *   TERM                   dumb terminals misbehave without it (pagers, colour)
 */
export const ENV_ALWAYS_KEEP: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'COMSPEC',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'SYSTEMDRIVE', 'SystemDrive',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_MESSAGES', 'TERM',
]);

/**
 * A name matching this is credential-shaped and is stripped unless it is on the
 * keep list. Case-insensitive substring matching, which is what caught
 * AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, NPM_TOKEN, ANTHROPIC_API_KEY,
 * SSH_PRIVATE_KEY, AWS_SESSION_TOKEN in the legacy suite.
 *
 * It matches names only, so it cannot see a secret hiding in an innocuously named
 * variable — `DATABASE_URL=postgres://user:pass@host` survives. That is a
 * deliberate limit, not an oversight: a heuristic over VALUES cannot tell a
 * credential from a coincidence, and a false positive silently breaks a working
 * command. Covering that surface is an explicit deny entry, not a smarter regex.
 */
export const ENV_SENSITIVE = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE)/i;

export interface RedactionRequest {
  /**
   * Extra names to strip: either an exact variable name (matched
   * case-insensitively) or a `/regex/` string. The legacy syntax, kept so
   * existing configuration keeps working.
   */
  readonly deny?: readonly string[];
}

export interface RedactionResult {
  /** The environment a child may see. Always a new object; the input is never mutated. */
  readonly env: Readonly<Record<string, string>>;
  /** Names that were stripped. Names only — never a value. Sorted, so logs are stable. */
  readonly removed: readonly string[];
  /** Deny entries that were not usable: a `/pattern/flags` string with an invalid regex. */
  readonly ignoredDeny: readonly string[];
}

// `/pattern/flags` and nothing else: a bare `/` is not a regex, so the closing slash
// is what makes the form unambiguous.
const DENY_ENTRY = /^\/(.*)\/([a-z]*)$/;

export function redactEnv(env: Readonly<Record<string, string>>, request: RedactionRequest = {}): RedactionResult {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const ignoredDeny: string[] = [];

  for (const entry of request.deny ?? []) {
    if (typeof entry !== 'string') continue;
    const match = DENY_ENTRY.exec(entry);
    if (match === null) {
      exact.add(entry.toLowerCase());
      continue;
    }
    try {
      patterns.push(new RegExp(match[1] ?? '', match[2] ?? ''));
    } catch {
      // Reported rather than swallowed: a typo in configuration should be visible,
      // the same way an unsupported glob is (research/p2-ports.md §3.1 item 9).
      ignoredDeny.push(entry);
    }
  }

  const out: Record<string, string> = {};
  const removed: string[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (ENV_ALWAYS_KEEP.has(name)) {
      out[name] = value;
      continue;
    }
    const stripped =
      exact.has(name.toLowerCase()) ||
      patterns.some((pattern) => pattern.test(name)) ||
      ENV_SENSITIVE.test(name);
    if (stripped) removed.push(name);
    else out[name] = value;
  }

  return { env: out, removed: removed.sort(), ignoredDeny };
}