// Linux backend: turn a resolved policy into a bubblewrap invocation.
//
// Pure argv generation on purpose — no spawning here — so the whole policy→flags
// mapping is unit-testable without a Linux host or an installed bwrap. The child
// process is started by src/sandbox/exec.js.
//
// Denial is expressed as MOUNTS, because bwrap cannot say "deny this path": a
// path is made unreachable (workspace profile: it was never bound) or invisible
// (hide profile: an empty tmpfs over a directory, /dev/null over a file). Mount
// order therefore carries meaning — later operations win:
//
//   workspace profile (default): bubblewrap starts from an empty root, and we
//     bind ONLY what the policy allows. Reads outside the project + the system
//     directories simply do not exist, which is what makes "a sandboxed read
//     cannot leak a private document" true rather than aspirational.
//   hide profile (compat): bind all of / read-only, then hide the denied paths.
//     Reads stay open everywhere else — chosen when a toolchain needs a path we
//     cannot enumerate, at the cost of the read guarantee above.

import { statSync } from 'node:fs';

const SHELL = '/bin/bash';

// Directories a normal build/test/version-control workflow needs to READ. Kept
// as an explicit list so that widening it is a reviewable decision.
export const WORKSPACE_READ_PATHS = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32',
  '/etc', '/opt', '/run',
];

const isDir = (p) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
const isFile = (p) => {
  try { return statSync(p).isFile(); } catch { return false; }
};

// Filesystem probing is injectable so the argv mapping can be tested anywhere:
// on Windows `/usr` does not exist, and a builder that consults the real FS would
// simply skip every system path — the test would pass while proving nothing.
const defaultFs = {
  isDir,
  isFile,
  exists: (p) => isDir(p) || isFile(p),
};

function bind(src, dest, { readOnly }) {
  const flag = readOnly ? '--ro-bind' : '--bind';
  return [flag, src, dest];
}

// Hides a denied read path without touching anything else.
function hideRead(p, fs) {
  if (fs.isDir(p)) return ['--tmpfs', p];
  if (fs.isFile(p)) return ['--ro-bind', '/dev/null', p];
  return null;
}

// Makes an allowed write path writable. Write-denied children are rebound
// read-only afterwards, which preserves their contents (hiding a write-denied
// FILE would replace it with /dev/null — that is not what a write rule means).
function allowWrite(p, fs) {
  if (!fs.exists(p)) return null;
  return bind(p, p, { readOnly: false });
}

// The sandbox always gets its own /tmp: a fresh, empty, writable tmpfs. Sharing
// the host's temp directory would make every other process's scratch files
// readable and turn "writes stay inside the project" into a half-truth — the
// first CI run of the enforcement tests caught exactly that, because the host
// tmpdir was also in write.allow and the later bind silently undid the tmpfs.
// A user who genuinely needs the host's /tmp can still add it to write.allow.
function privateTmpArgs() {
  return ['--tmpfs', '/tmp'];
}

function denyWrite(p, fs) {
  if (!fs.exists(p)) return null;
  return bind(p, p, { readOnly: true });
}

/**
 * @param {object} policy resolved by src/sandbox/policy.js
 * @param {{command:string,cwd:string,shell?:string,fs?:object}} opts
 * @returns {{ file: string, args: string[] }}
 */
export function buildBwrapCommand(policy, { command, cwd, shell = SHELL, fs = defaultFs } = {}) {
  const args = [
    '--die-with-parent', // no sandboxed process outliving the tool call
    '--new-session',     // detach the controlling terminal (no TIOCSTI games)
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
  ];
  // Network is namespace-level, never proxy-env-level: a client that ignores
  // HTTP_PROXY (Node's fetch, for one) must still be unable to connect. Measured
  // as bypassable when done with env vars — research §2.5.
  if (policy.network === 'off') args.push('--unshare-net');

  args.push('--dev-bind-try', '/dev', '/dev');
  args.push('--proc', '/proc');

  if (policy.read.profile === 'workspace') {
    // bubblewrap starts from an empty root here: bind exactly the read surface.
    for (const p of [...WORKSPACE_READ_PATHS, ...policy.read.allow]) {
      if (fs.isDir(p)) args.push(...bind(p, p, { readOnly: true }));
      else if (fs.isFile(p)) args.push('--ro-bind-try', p, p);
    }
    // A denied path inside an allowed tree still has to be removed.
    for (const p of policy.read.deny) {
      const hide = hideRead(p, fs);
      if (hide) args.push(...hide);
    }
    args.push(...privateTmpArgs());
  } else {
    args.push('--ro-bind', '/', '/');
    for (const p of policy.read.deny) {
      const hide = hideRead(p, fs);
      if (hide) args.push(...hide);
    }
    // Even in the open-read profile the sandbox gets its own scratch space: the
    // host /tmp comes in read-only via `--ro-bind / /` otherwise, which breaks
    // every build tool that writes a temp file.
    args.push(...privateTmpArgs());
  }

  for (const p of policy.write.allow) {
    const w = allowWrite(p, fs);
    if (w) args.push(...w);
  }
  for (const p of policy.write.deny) {
    const d = denyWrite(p, fs);
    if (d) args.push(...d);
  }

  args.push('--chdir', cwd, '--', shell, '-c', command);
  return { file: 'bwrap', args };
}

// What this policy asks for that the v1 backend cannot express. Surfaced by
// /sandbox and doctor instead of being silently ignored: a policy that pretends
// to restrict something it does not is worse than a smaller honest one.
export function bwrapLimitations(policy) {
  const out = policy.unsupported.map((u) => `${u.in}: ${u.entry} — ${u.why}`);
  if (policy.network === 'ask') {
    out.push('network "ask" behaves as "off" until per-command approval lands (Phase 1b)');
  }
  if (policy.read.profile === 'hide') {
    out.push('read profile "hide": reads are open outside the denied paths (credentials are still unreachable)');
  }
  return out;
}

export const BWRAP_SHELL = SHELL;
