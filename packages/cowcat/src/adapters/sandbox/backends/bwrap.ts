// Linux backend: turn a resolved policy into a bubblewrap invocation.
//
// PURE argv generation on purpose — nothing is spawned here — so the whole
// policy→flags mapping is testable on any machine. On Windows `/usr` does not exist,
// so a builder that consulted the real filesystem would skip every system path and
// the test would pass while proving nothing; the probe is therefore injected.
//
// Denial is expressed as MOUNTS, because bwrap cannot say "deny this path". A path
// is made unreachable (workspace profile: it was never bound, so the tool sees
// ENOENT — measured) or invisible (hide profile: an empty tmpfs over a directory,
// /dev/null over a file). Mount order therefore carries meaning: later operations win.

import type { SandboxProfile } from '../../../ports/index.js';
import { SANDBOX_TMPFS_BYTES } from '../../../policy/sandbox-defaults.js';

/**
 * Directories a normal build/test/version-control workflow needs to READ. An explicit
 * list so that widening it is a reviewable decision rather than a side effect.
 *
 * `/etc` is in here, which means root-owned files under it are readable — file
 * permissions are still enforced by the kernel, and the measurement is decisive: as a
 * non-root caller `/etc/shadow` is denied inside the sandbox, as a root caller it is
 * readable (research/p2-sandbox.md §4.2). The sandbox maps the caller's privileges, it
 * does not reduce them.
 */
export const BWRAP_READ_PATHS: readonly string[] = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32',
  '/etc', '/opt', '/run',
];

export interface SandboxFsProbe {
  readonly isDir: (path: string) => boolean;
  readonly isFile: (path: string) => boolean;
  /**
   * Canonical spelling, the same one `policy/sandbox-paths.ts` gives every policy entry.
   *
   * Present because a path can enter a profile from OUTSIDE the policy resolver — the
   * scratch directory is created by the executor — and on macOS `/var` is a symlink to
   * `/private/var`, so an un-canonicalised path yields `(subpath /var/…)`, which Seatbelt
   * matches against nothing. Measured: the sandbox's own TMPDIR came back unwritable,
   * which breaks every toolchain that needs scratch space, and it presents as a policy
   * that grants nothing.
   */
  readonly canonical: (path: string) => string;
}

export interface BwrapOptions {
  readonly command: string;
  readonly cwd: string;
  readonly shell?: string;
  readonly fs: SandboxFsProbe;
  /** Extra isolation this machine was probed as accepting. Empty = ship without it. */
  readonly hardening?: readonly string[];
  readonly tmpfsBytes?: number;
}

export interface BwrapCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** What the backend could not express. Surfaced by the caller, never swallowed. */
  readonly limitations: readonly string[];
}

const SHELL = '/bin/bash';

export function buildBwrapCommand(profile: SandboxProfile, options: BwrapOptions): BwrapCommand {
  const shell = options.shell ?? SHELL;
  const fs = options.fs;
  const args: string[] = [
    '--die-with-parent', // no sandboxed process outliving the tool call (measured: PDEATHSIG)
    '--new-session',     // setsid: the sandbox cannot write to the controlling terminal
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
  ];

  const limitations: string[] = [];

  // Nested user namespaces: measured, a sandboxed process CAN create one (research
  // §4.1), which hands it CAP_SYS_ADMIN over its own mount view. `disable-userns`
  // closes it, and is only emitted when the probe confirmed this kernel accepts it —
  // a weaker sandbox beats a first command that fails.
  const hardening = options.hardening ?? [];
  if (hardening.includes('disable-userns')) {
    args.push('--unshare-user', '--disable-userns', '--assert-userns-disabled');
  } else {
    limitations.push(
      'nested user namespaces could not be disabled on this kernel, so a sandboxed command can create its own',
    );
  }

  // Network is namespace-level, never proxy-env-level: a client that ignores
  // HTTP_PROXY (Node's fetch, for one) must still be unable to connect. Verified by
  // running a raw /dev/tcp connect, not by trusting the flag.
  if (profile.network !== 'on') args.push('--unshare-net');

  args.push('--dev-bind-try', '/dev', '/dev', '--proc', '/proc');

  // Its own scratch space, always: sharing the host's /tmp would make every other
  // process's temp files readable and turn "writes stay in the project" into a
  // half-truth. Capped, and world-writable with a sticky bit like the real thing —
  // the default tmpfs is 0755 and half of RAM (research §4.6).
  const tmpfs = ['--perms', '1777', '--size', String(options.tmpfsBytes ?? SANDBOX_TMPFS_BYTES), '--tmpfs', '/tmp'];

  if (profile.read.profile === 'workspace') {
    // bubblewrap starts from an empty root here: bind exactly the read surface, so
    // anything else is not merely unreadable but ABSENT (measured: ENOENT).
    //
    // The tmpfs goes FIRST, and that order is load-bearing. Mounts are applied in
    // command-line order and later ones win, so a `--tmpfs /tmp` emitted after the read
    // binds SHADOWS every read allowance that lives under the host's /tmp — measured:
    // with the tmpfs last, an allowed `$HOME/notes.txt` inside a `/tmp` project is gone,
    // which is a policy that appears to grant something and does nothing. Putting it
    // first lets the policy's own binds re-expose what it meant to expose.
    args.push(...tmpfs);
    for (const path of [...BWRAP_READ_PATHS, ...profile.read.allow]) {
      if (fs.isDir(path)) args.push('--ro-bind', path, path);
      else if (fs.isFile(path)) args.push('--ro-bind-try', path, path);
    }
    for (const path of profile.read.deny) {
      const hidden = hideRead(path, fs);
      if (hidden !== null) args.push(...hidden);
    }
  } else {
    // Here the order is the opposite, and deliberately so: `--ro-bind / /` binds the
    // whole root INCLUDING the host's /tmp, so a tmpfs emitted before it would be
    // shadowed by the root bind and the sandbox would inherit the host's temp directory
    // again. The root bind must come first, then the hides, then the tmpfs.
    args.push('--ro-bind', '/', '/');
    for (const path of profile.read.deny) {
      const hidden = hideRead(path, fs);
      if (hidden !== null) args.push(...hidden);
    }
    args.push(...tmpfs);
    limitations.push('read profile "hide": reads are open outside the denied paths (the denied paths are still unreachable)');
  }

  for (const path of profile.write.allow) {
    // A source that does not exist is a HARD failure for the whole command
    // ("Can't find source path"), so it cannot simply be bound. Skipping it means the
    // sandbox can never create that path — which is exactly the kind of silent
    // nothing that has to be reported instead of swallowed (research §4.5).
    if (!fs.isDir(path) && !fs.isFile(path)) {
      limitations.push(`write.allow: ${path} was not granted because it does not exist yet; the sandbox cannot create it`);
      continue;
    }
    args.push('--bind', path, path);
  }
  for (const path of profile.write.deny) {
    if (!fs.isDir(path) && !fs.isFile(path)) continue;
    // Rebound read-only, which preserves the contents. Hiding a write-denied FILE
    // would replace it with /dev/null, which is not what a write rule means.
    args.push('--ro-bind', path, path);
  }

  args.push('--chdir', options.cwd, '--', shell, '-c', options.command);
  return { file: 'bwrap', args, limitations };
}

/** Makes a denied read path unreachable without touching anything else. */
function hideRead(path: string, fs: SandboxFsProbe): readonly string[] | null {
  if (fs.isDir(path)) return ['--tmpfs', path];
  if (fs.isFile(path)) return ['--ro-bind', '/dev/null', path];
  return null;
}