// macOS backend: turn a resolved policy into a `sandbox-exec` invocation.
//
// PURE argv + profile generation, like the bwrap builder — nothing is spawned here,
// so the whole policy→SBPL mapping is unit-testable on any machine, including the
// Windows one this suite runs on. The child process is started by the gateway.
//
// ── The Seatbelt semantics that are NOT what you would guess ─────────────────
// Verified against the reference implementation (@anthropic-ai/sandbox-runtime,
// Apache-2.0; its dist/sandbox/macos-sandbox-utils.js), because guessing here is how
// you ship a sandbox that looks right and denies nothing:
//
// 1. **Last match wins.** A `(deny file-read* (subpath ~/.ssh))` emitted BEFORE
//    `(allow file-read* (subpath /Users/me/proj))` would be undone by the allow. So
//    the credential denies are emitted AFTER every read allow, always.
// 2. **A specific deny beats a wildcard allow** — `(deny file-write-unlink …)` is
//    not overridden by a later `(allow file-write*)`, which is why the write roots
//    have to re-allow unlink/create or `rm` breaks.
// 3. **`(deny default)` kills dyld before exec** unless the process needs are there:
//    sysctls, a handful of mach services, ipc-posix-shm/sem, file-ioctl on the
//    device files. The runtime block below is not decoration; srt reports macOS 26
//    aborting on un-whitelisted `hw.*` sysctls (zsh 5.9).
// 4. **`realpath()` needs directory metadata.** `(allow file-read-metadata
//    (vnode-type DIRECTORY))` or every path crossing a denied region fails to
//    resolve. It is metadata only, and it is emitted AFTER the read denies so denied
//    directories stay denied.
// 5. **`mv` defeats a path deny.** `mv .env x` moves a read-denied file into a
//    writable name. Hence the file-write-unlink / file-write-create blocks on the
//    denied paths and their ancestors, plus a tail block for denied paths that sit
//    INSIDE a write root.
// 6. **A string literal over 1025 bytes aborts the whole profile** with "Error
//    reading string" — so a path list, not one rule per path.
// 7. **An allow-LIST of `(subpath …)` filters does not cover `/` itself.** Measured
//    on macOS 15: dyld aborts before exec with SIGABRT and no message, which reads
//    as an unrelated crash rather than a missing rule. Hence the explicit
//    `(allow file-read* (literal "/"))`.
//
// ATTRIBUTION: RUNTIME_ALLOWS below is transcribed from @anthropic-ai/sandbox-runtime,
// which is licensed Apache-2.0; see NOTICE at the repository root. Changes from the
// original: the sysctl and mach-lookup entries were kept as enumerated lists rather
// than wildcards, and the profile assembly order follows the seven notes above.
//
// Not done here (scope, stated so it can't be mistaken for support):
//   - **No per-domain network control.** Seatbelt cannot filter by hostname; the
//     industry answer is a sandbox-external proxy (Claude Code / Codex / srt all do
//     that). `network: 'on'` is therefore REFUSED by the executor, not granted and
//     broken.
//   - **No violation attribution.** `(with message …)` writes into the sandbox
//     violation log store, which needs its own permission story. Denials are read
//     back off the command's stderr instead.

import type { SandboxProfile } from '../../../ports/index.js';

const SHELL = '/bin/bash';
const EXEC = '/usr/bin/sandbox-exec';

// SBPL escapes a path the way JSON does.
const lit = (path: string): string => JSON.stringify(path);
const sub = (path: string): string => `(subpath ${lit(path)})`;
const literal = (path: string): string => `(literal ${lit(path)})`;

function rule(action: string, ops: readonly string[], filters: readonly string[]): string[] {
  if (filters.length === 0) return [];
  return [`(${action} ${ops.join(' ')}`, ...filters.map((filter) => `  ${filter}`), ')'];
}

function uniq(list: readonly (string | null | undefined)[]): string[] {
  return [...new Set(list.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))];
}

/**
 * Directories a normal build/test/VCS workflow needs to READ. A separate list from
 * bwrap's: macOS keeps the toolchain under /usr, /opt and /System.
 *
 * THE SPELLING IS THE POINT. These are KERNEL paths, not the paths a person types.
 * Seatbelt matches `(subpath …)` against what the kernel reports, and on macOS `/etc`,
 * `/var` and `/tmp` are all symlinks into `/private`. A profile written with the
 * friendly spelling grants nothing — and because a missing read grant is not an EPERM
 * but a dyld SIGABRT, it looks like an unrelated crash.
 */
export const SEATBELT_READ_PATHS: readonly string[] = [
  '/usr', '/bin', '/sbin', '/lib', '/opt', '/System',
  '/private/etc',      // resolv.conf — /etc is a symlink to this
  '/private/var/db',   // dyld shared cache
  '/private/var/run',  // mDNSResponder socket
  '/dev',
];

/**
 * The runtime floor: the minimum a /bin/bash process needs to start and run ordinary
 * commands under `(deny default)` on a stock macOS.
 *
 * TRANSCRIBED FROM @anthropic-ai/sandbox-runtime (Apache-2.0) — see NOTICE. Kept as a
 * transcribed list rather than re-derived because the failure mode of getting it wrong
 * is a silent SIGABRT before exec, which costs a macOS machine to find; it is verified
 * for real by the `packages/cowcat · node 22 · macos-15` CI leg.
 *
 * The sysctl names are enumerated rather than wildcarded, because widening the set is
 * then a reviewable decision — except for the architecture-dependent prefixes.
 */
export const RUNTIME_ALLOWS: readonly string[] = [
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow signal (target same-sandbox))',
  '(allow process-info* (target same-sandbox))',
  '(allow mach-priv-task-port (target same-sandbox))',
  '(allow user-preference-read)',
  '(allow ipc-posix-shm)',
  '(allow ipc-posix-sem)',
  '(allow distributed-notification-post)',
  '(allow iokit-get-properties)',
  '(allow iokit-open',
  '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
  '  (iokit-registry-entry-class "RootDomainUserClient")',
  '  (iokit-user-client-class "IOSurfaceSendRight")',
  ')',
  // NSS/system-sockets only — this is NOT network access.
  '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
  '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty"))',
  '(allow file-ioctl file-read-data file-write-data',
  '  (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
  '(allow mach-lookup',
  '  (global-name "com.apple.system.logger")',
  '  (global-name "com.apple.system.logd")',
  '  (global-name "com.apple.coreservices.launchservicesd")',
  '  (global-name "com.apple.securityd.xpc")',
  '  (global-name "com.apple.bsd.dirhelper")',
  '  (global-name "com.apple.audio.systemsoundserver")',
  '  (global-name "com.apple.fonts")',
  '  (global-name "com.apple.FontObjectsServer")',
  '  (global-name "com.apple.system.opendirectoryd.libinfo")',
  ')',
  '(allow sysctl-read',
  '  (sysctl-name "hw.activecpu")',
  '  (sysctl-name "hw.memsize")',
  '  (sysctl-name "hw.ncpu")',
  '  (sysctl-name "hw.pagesize")',
  '  (sysctl-name "hw.physicalcpu")',
  '  (sysctl-name "hw.physicalcpu_max")',
  '  (sysctl-name "hw.logicalcpu")',
  '  (sysctl-name "hw.logicalcpu_max")',
  '  (sysctl-name "hw.byteorder")',
  '  (sysctl-name "hw.cputype")',
  '  (sysctl-name "hw.cpufamily")',
  '  (sysctl-name "hw.packages")',
  '  (sysctl-name "hw.tbfrequency")',
  '  (sysctl-name "hw.vectorunit")',
  '  (sysctl-name "hw.busfrequency_compat")',
  '  (sysctl-name "hw.cacheconfig")',
  '  (sysctl-name "hw.cachelinesize_compat")',
  '  (sysctl-name "hw.l1dcachesize_compat")',
  '  (sysctl-name "hw.l1icachesize_compat")',
  '  (sysctl-name "hw.l2cachesize_compat")',
  '  (sysctl-name "hw.l3cachesize_compat")',
  '  (sysctl-name "hw.cpufrequency")',
  '  (sysctl-name "hw.cpufrequency_compat")',
  '  (sysctl-name "hw.cpufrequency_max")',
  '  (sysctl-name "hw.perflevel0.name")',
  '  (sysctl-name-prefix "hw.optional.arm")',
  '  (sysctl-name-prefix "hw.optional.arm.")',
  '  (sysctl-name-prefix "hw.optional.armv8_")',
  '  (sysctl-name-prefix "hw.perflevel")',
  '  (sysctl-name-prefix "machdep.cpu.")',
  '  (sysctl-name-prefix "kern.proc.")',
  '  (sysctl-name "kern.argmax")',
  '  (sysctl-name "kern.bootargs")',
  '  (sysctl-name "kern.hostname")',
  '  (sysctl-name "kern.maxfiles")',
  '  (sysctl-name "kern.maxfilesperproc")',
  '  (sysctl-name "kern.osproductversion")',
  '  (sysctl-name "kern.osrelease")',
  '  (sysctl-name "kern.ostype")',
  '  (sysctl-name "kern.version")',
  '  (sysctl-name "kern.uuid")',
  '  (sysctl-name "vm.loadavg")',
  ')',
  // V8 needs to read this one.
  '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
];

export interface SeatbeltOptions {
  readonly command: string;
  readonly cwd: string;
  readonly shell?: string;
  /** A private, EMPTY scratch directory. macOS has no mount namespaces, so the caller creates it. */
  readonly tmpDir?: string | null;
}

export interface SeatbeltCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly limitations: readonly string[];
}

/** Every parent of `path`, closest first. Used to stop a denied path from being renamed out from under its own deny. */
function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let current = path;
  for (;;) {
    const index = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'));
    if (index <= 0) return out;
    const parent = current.slice(0, index);
    out.push(parent);
    current = parent;
  }
}

/** Is `child` strictly inside `parent`? String-based on purpose: these paths are only compared and emitted, never touched. */
export function isUnder(child: string, parent: string): boolean {
  const c = child.replace(/[/\\]+$/, '');
  const q = parent.replace(/[/\\]+$/, '');
  return c !== q && c.startsWith(q) && /[/\\]/.test(c.slice(q.length));
}

function networkSection(profile: SandboxProfile): string[] {
  // The executor refuses `network: 'on'` on seatbelt, so reaching the second branch
  // means something bypassed that guard. Render the profile honestly rather than
  // silently pretending the network is off.
  if (profile.network !== 'on') return ['; network denied (policy: ' + profile.network + ')'];
  return [
    '(allow network*)',
    // DNS on macOS does not go out to port 53: it is a call into mDNSResponder over a
    // LOCAL UNIX SOCKET. Insufficient on its own — see the executor's refusal.
    '(allow system-socket (socket-domain AF_UNIX))',
    '(allow network-outbound (remote unix-socket (subpath "/private/var/run/mdnsd")))',
    '(allow network-bind (local unix-socket (subpath "/private/var/run/mdnsd")))',
  ];
}

function readSection(profile: SandboxProfile): string[] {
  const lines: string[] = [];
  const open = profile.read.profile === 'hide';
  if (open) lines.push('(allow file-read*)');
  else lines.push(...rule('allow', ['file-read*'], uniq([...SEATBELT_READ_PATHS, ...profile.read.allow].map(sub))));
  // AFTER the allows — note 1.
  lines.push(...rule('deny', ['file-read*'], uniq(profile.read.deny.map(sub))));
  // Note 7: an allow-LIST of subpaths does not cover the root inode, and dyld aborts
  // before exec with no message when it is missing. What it costs: `ls /` can list
  // the top-level names. It grants no subtree content.
  if (!open) lines.push('(allow file-read* (literal "/"))');
  // AFTER the denies — note 4.
  lines.push('(allow file-read-metadata (vnode-type DIRECTORY))');
  return lines;
}

/** Renaming a read-denied path is a read bypass (note 5). */
function moveBlocking(readDeny: readonly string[]): string[] {
  const filters = new Set<string>();
  for (const path of readDeny) {
    filters.add(sub(path));
    for (const ancestor of ancestorsOf(path)) filters.add(literal(ancestor));
  }
  return rule('deny', ['file-write-unlink', 'file-write-create'], [...filters]);
}

function writeSection(profile: SandboxProfile, tmpDir: string | null): string[] {
  const roots = uniq([...profile.write.allow, ...(tmpDir === null ? [] : [tmpDir])]);
  const lines: string[] = [];
  lines.push(...rule('allow', ['file-write*'], roots.map(sub)));
  lines.push(...rule('deny', ['file-write*'], uniq(profile.write.deny.map(sub))));
  lines.push(...moveBlocking(profile.read.deny));
  // The read section's move-blocking deny outranks a wildcard allow (note 2), so
  // unlink/create is re-opened for the write roots — otherwise `rm` inside the
  // project is impossible.
  lines.push(...rule('allow', ['file-write-unlink', 'file-write-create'], roots.map(sub)));
  return lines;
}

/** A read-denied path INSIDE a write root became renameable when the write section re-allowed unlink. Take it back, last. */
function readDenyUnlinkTail(profile: SandboxProfile): string[] {
  const roots = uniq(profile.write.allow);
  if (roots.length === 0) return [];
  const filters = new Set<string>();
  for (const path of profile.read.deny) {
    const under = roots.find((root) => isUnder(path, root));
    if (under === undefined) continue;
    filters.add(sub(path));
    for (const ancestor of ancestorsOf(path)) {
      // Only the ancestors strictly inside the write root: re-denying the root itself
      // would block unrelated work in the project.
      if (isUnder(ancestor, under)) filters.add(literal(ancestor));
    }
  }
  return rule('deny', ['file-write-unlink'], [...filters]);
}

export function buildSeatbeltCommand(profile: SandboxProfile, options: SeatbeltOptions): SeatbeltCommand {
  const shell = options.shell ?? SHELL;
  const tmpDir = options.tmpDir ?? null;
  const limitations: string[] = [];

  if (profile.network === 'on') {
    limitations.push(
      'network "on" is not deliverable inside a Seatbelt sandbox: name resolution does not come back however much is allowed (measured on macOS 15). Per-domain egress needs a sandbox-external proxy.',
    );
  }
  if (profile.read.profile === 'hide') {
    limitations.push('read profile "hide": reads are open outside the denied paths (the denied paths are still unreachable)');
  }

  const profile2 = [
    '(version 1)',
    // No `(with message …)`: that writes into the sandbox violation log store and needs
    // its own permission story. Denials are read back off stderr instead.
    '(deny default)',
    '',
    '; Runtime floor — a /bin/bash process cannot start without these.',
    ...RUNTIME_ALLOWS,
    '',
    '; Network',
    ...networkSection(profile),
    '',
    '; File read',
    ...readSection(profile),
    '',
    '; File write',
    ...writeSection(profile, tmpDir),
    '',
  ];

  const tail = readDenyUnlinkTail(profile);
  if (tail.length > 0) profile2.push('; Read-denied paths inside write roots stay in place', ...tail, '');

  // The private temp dir must also be READABLE, not just writable, or a build tool
  // cannot read back what it just wrote there.
  if (tmpDir !== null && profile.read.profile !== 'hide') {
    profile2.push(`(allow file-read* ${sub(tmpDir)})`);
  }

  // `-p` takes the profile as ONE argv element; the command after it is exec'd
  // directly, so the model's command never passes through a shell twice.
  return {
    file: EXEC,
    args: ['-p', profile2.join('\n'), shell, '-c', options.command],
    limitations,
  };
}