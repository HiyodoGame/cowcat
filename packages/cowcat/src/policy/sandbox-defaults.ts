// The default sandbox policy (P2 T5), migrated from
// agent/src/sandbox/policy.js. Kept as constants here so the shape of the default
// is a reviewable, greppable decision rather than something assembled on the way
// to a command line.
//
// Deliberately opinionated, each with the reason it exists:
//
//   * reads are deny-then-allow with the credential locations denied HARD — the
//     legacy finding was that a sandboxed read is enough to leak a private document
//     (research §2.5/§2.6), so they are denied even when a broader allow covers them;
//   * writes are allow-only, because "anything not granted is denied" is the only
//     shape that does not rot as new paths appear;
//   * network is off.
//
// The empirical consequence of dropping the credential denies is that the mode gets
// switched off by users within a day, so the home read-allow list is here too:
// without `~/.gitconfig` and `~/.npm` a `git commit` inside the sandbox has no
// identity and npm has no cache.

/**
 * Denied for READS even when a broader allow rule covers them: this is the whole
 * point of the tier. `~` is resolved against the caller's home directory.
 */
export const DEFAULT_READ_DENY: readonly string[] = [
  '~/.ssh',
  '~/.config/gh',
  '~/.git-credentials',
  '~/.cowcat',
  '~/.aws',
  '~/.gnupg',
];

/**
 * Home paths toolchains genuinely need. Not optional comfort: without these,
 * `git commit` inside the sandbox has no identity and npm has no cache.
 */
export const DEFAULT_HOME_READ_ALLOW: readonly string[] = ['~/.gitconfig', '~/.npm', '~/.cache'];

/**
 * Denied for WRITES, relative to the session cwd. `.env` because a sandboxed write
 * to it is how a secret reaches a commit; `.git/hooks` because a hook is code that
 * runs on the user's machine outside every sandbox decision we make.
 */
export const DEFAULT_WRITE_DENY: readonly string[] = ['.env', '.git/hooks'];

/**
 * The private scratch directory given to a sandbox, capped.
 *
 * Measured: `--tmpfs /tmp` with no `--size` gets half of RAM (19.5 GiB on a 40 GiB
 * machine), and tmpfs is RAM-backed — so one runaway build inside the sandbox can eat
 * half the machine (research/p2-sandbox.md §4.6). 2 GiB is comfortably more than
 * ordinary toolchain scratch use while still being a limit rather than a promise.
 *
 * A build that genuinely needs more fails with ENOSPC, which is an error the user can
 * act on — strictly better than silently consuming the host's memory.
 */
export const SANDBOX_TMPFS_BYTES = 2 * 1024 * 1024 * 1024;