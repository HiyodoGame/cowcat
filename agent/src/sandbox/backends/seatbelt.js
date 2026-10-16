// macOS backend: turn a resolved policy into a `sandbox-exec` invocation.
//
// PURE argv + profile generation, like backends/bwrap.js — nothing is spawned
// here, so the whole policy→SBPL mapping is unit-testable on any machine. The
// child process is started by src/tools/bash.js.
//
// ── The Seatbelt semantics that are NOT what you would guess ─────────────────
// Verified against the reference implementation (@anthropic-ai/sandbox-runtime,
// Apache-2.0; its dist/sandbox/macos-sandbox-utils.js), because guessing here is
// how you ship a sandbox that looks right and denies nothing:
//
// 1. **Last match wins.** A `(deny file-read* (subpath ~/.ssh))` emitted BEFORE
//    `(allow file-read* (subpath /Users/me/proj))` would be undone by the allow.
//    So the credential denies are emitted AFTER every read allow, always.
// 2. **A specific deny beats a wildcard allow** — `(deny file-write-unlink …)`
//    is not overridden by a later `(allow file-write*)`, which is why srt has to
//    re-allow unlink/create for write roots explicitly or `rm` breaks.
// 3. **`(deny default)` kills dyld before exec** unless the process needs are
//    there: sysctls, a handful of mach services, ipc-posix-shm/sem, file-ioctl
//    on the device files. The runtime block below is not decoration; srt reports
//    macOS 26 aborting on un-whitelisted `hw.*` sysctls (zsh 5.9).
// 4. **`realpath()` needs directory metadata.** `(allow file-read-metadata
//    (vnode-type DIRECTORY))` or every path crossing a denied region fails to
//    resolve. It is metadata only — no readdir, no file contents — and it is
//    emitted AFTER the read denies so denied directories stay denied.
// 5. **`mv` defeats a path deny.** `mv .env x` moves a read-denied file into a
//    writable name. Hence the `file-write-unlink` / `file-write-create` blocks on
//    the denied paths and their ancestors, plus a tail block for denied paths
//    that sit INSIDE a write root (the write section re-allows them; the tail
//    takes them back).
// 6. **A string literal over 1025 bytes aborts the whole profile** with "Error
//    reading string" — so a path list, not one rule per path.
//
// Not done here (scope, stated so it can't be mistaken for support):
//   - **No per-domain network control.** Seatbelt cannot filter by hostname; the
//     industry answer is a sandbox-external proxy (Claude Code / Codex / srt all
//     do that). v1 offers off / ask / on only — see docs Phase 3.
//   - **No violation attribution.** `(with message …)` writes into the sandbox
//     violation log store, which needs its own permission story (plan §10).
//     Denials are inferred from the command's own stderr, same as Linux.

import { dirname } from 'node:path';

const SHELL = '/bin/bash';
const EXEC = '/usr/bin/sandbox-exec';

// SBPL escapes a path the way JSON does — same helper srt uses.
const lit = (p) => JSON.stringify(p);

const sub = (p) => `(subpath ${lit(p)})`;
const literal = (p) => `(literal ${lit(p)})`;

function rule(action, ops, filters) {
  if (!filters.length) return [];
  return [`(${action} ${ops.join(' ')}`, ...filters.map((f) => `  ${f}`), ')'];
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

// Every parent of `p`, closest first, stopping at the root. Used to stop a
// denied path from being renamed out from under its own deny.
//
// NO resolve() here: every path that reaches this backend is already an absolute
// canonical path from policy.expandPath(). Resolving again would re-attach a
// drive letter on Windows. The backend only ever runs on macOS, but a pure
// function that silently depends on the machine it runs on cannot be tested
// anywhere else — and this one is tested on Windows too.
function ancestorsOf(p) {
  const out = [];
  let cur = p;
  for (;;) {
    const parent = dirname(cur);
    if (!parent || parent === cur) return out;
    out.push(parent);
    cur = parent;
  }
}

// Is `child` strictly inside `parent`? Separator-agnostic for the same reason,
// and deliberately string-based: these paths are only ever compared and emitted,
// never passed to the filesystem.
function isUnder(child, parent) {
  const c = String(child).replace(/[\\/]+$/, '');
  const q = String(parent).replace(/[\\/]+$/, '');
  return c !== q && c.startsWith(q) && /[\\/]/.test(c.slice(q.length));
}

// The runtime floor. Short list, long justification: it is the minimum a
// /bin/bash process needs to start and run ordinary commands under
// `(deny default)` on a stock macOS, transcribed from the reference
// implementation's profile (Apache-2.0). Widening it is a reviewable decision,
// which is why the sysctl names are enumerated rather than wildcarded — except
// for the `hw.optional.*` / `machdep.cpu.*` / `kern.proc.*` prefixes, which are
// architecture- and version-dependent by nature.
// Exported so tools/seatbelt-smoke.mjs can replay the floor and the read surface
// on a real macOS host. A missing read grant is not an EPERM on the syscall you
// would expect — dyld aborts while it is still loading, so the only way to find
// the missing path is to replay the surface with and without it.
export const RUNTIME_ALLOWS = [
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
  '  (sysctl-name "hw.cputype")',
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
  // V8 needs to read this one (transcribed from the reference profile).
  '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
];

// Directories a normal build/test/VCS workflow needs to READ. Deliberately a
// separate list from bwrap's: macOS keeps the toolchain under /usr, /opt and
// /System, and the dynamic loader also touches /System/Library.
//
// THE SPELLING IS THE POINT. These are KERNEL paths, not the paths a person
// types. Seatbelt matches `(subpath …)` against what the kernel reports, and on
// macOS `/etc`, `/var` and `/tmp` are all symlinks into `/private`. A profile
// written with the friendly spelling grants nothing and — because a missing read
// grant is not an EPERM but a dyld SIGABRT — looks like an unrelated crash.
// `/lib` and `/sbin` are symlinks into /usr and are listed only to document the
// layout.
export const SEATBELT_READ_PATHS = [
  '/usr', '/bin', '/sbin', '/lib', '/opt', '/System',
  '/private/etc',     // resolv.conf — /etc is a symlink to this
  '/private/var/db',   // dyld shared cache
  '/private/var/run',  // mDNSResponder socket
  '/dev',
];

// Networking. `off` (and `ask` without this call's approval) emits nothing, so
// `(deny default)` governs and a client that ignores proxy environment
// variables still cannot connect — the control has to be the profile, never the
// environment (research §2.5).
function networkSection(policy) {
  if (policy.network !== 'on') return [`; network denied (policy: ${policy.network})`];
  // Reachable only if a caller bypasses planBashCommand's guard, which is where
  // `network: 'on'` is refused for seatbelt (measured: resolution never comes
  // back up inside the sandbox). Kept for the profile generator's own contract —
  // the profile is still the honest rendering of "network allowed".
  return [
    '(allow network*)',
    // DNS on macOS does not go out to port 53: it is a call into mDNSResponder
    // over a LOCAL UNIX SOCKET. Kept even though it is not sufficient — see the
    // guard in planBashCommand — so this section is not silently misleading.
    '(allow system-socket (socket-domain AF_UNIX))',
    '(allow network-outbound (remote unix-socket (subpath "/private/var/run/mdnsd")))',
    '(allow network-bind (local unix-socket (subpath "/private/var/run/mdnsd")))',
  ];
}

function readSection(policy) {
  const lines = [];
  const open = policy.read.profile === 'hide';
  // workspace profile: reads are an allow-list from an otherwise denied tree,
  // which is what makes "a sandboxed read cannot leak a private document" true
  // rather than aspirational. hide profile: reads are open, minus the denies.
  if (open) lines.push('(allow file-read*)');
  else lines.push(...rule('allow', ['file-read*'], uniq([...SEATBELT_READ_PATHS, ...policy.read.allow]).map(sub)));
  // AFTER the allows — see header note 1.
  lines.push(...rule('deny', ['file-read*'], uniq(policy.read.deny).map(sub)));
  // The root inode itself. Measured on macOS 15: an allow-LIST built only from
  // `(subpath …)` filters does not cover `/`, `(deny default)` still does, and
  // dyld aborts before exec with SIGABRT and no message. A blanket
  // `(allow file-read*)` covers the root implicitly, which is why the same
  // profile works with the hide profile and dies with the workspace one. Same
  // trap as srt's issue #190, same fix.
  //
  // What it costs: `ls /` can list the top-level directory names. It grants no
  // subtree content — every entry below still needs its own allow.
  if (!open) lines.push('(allow file-read* (literal "/"))');
  // AFTER the denies — see header note 4.
  lines.push('(allow file-read-metadata (vnode-type DIRECTORY))');
  return lines;
}

// Renaming a read-denied path is a read bypass (see header note 5). Deny
// unlink/create on the denied paths and on the directories holding them, so the
// denied file cannot be renamed away — or replaced by a symlink we would then
// read through.
function moveBlocking(readDeny) {
  const filters = new Set();
  for (const p of readDeny) {
    filters.add(sub(p));
    for (const a of ancestorsOf(p)) filters.add(literal(a));
  }
  return rule('deny', ['file-write-unlink', 'file-write-create'], [...filters]);
}

function writeSection(policy, tmpDir) {
  const roots = uniq([...policy.write.allow, ...(tmpDir ? [tmpDir] : [])]);
  const lines = [];
  lines.push(...rule('allow', ['file-write*'], roots.map(sub)));
  lines.push(...rule('deny', ['file-write*'], uniq(policy.write.deny).map(sub)));
  lines.push(...moveBlocking(policy.read.deny));
  // The read section's move-blocking deny outranks a wildcard allow (note 2), so
  // unlink/create is re-opened for the write roots — otherwise `rm` inside the
  // project is impossible.
  lines.push(...rule('allow', ['file-write-unlink', 'file-write-create'], roots.map(sub)));
  return lines;
}

// A read-denied path that sits INSIDE a write root became renameable again when
// the write section re-allowed unlink. Take it back, last in the profile so
// nothing above can re-open it.
function readDenyUnlinkTail(policy) {
  const roots = uniq(policy.write.allow);
  if (!roots.length) return [];
  const filters = new Set();
  for (const p of policy.read.deny) {
    const under = roots.find((r) => isUnder(p, r));
    if (!under) continue;
    filters.add(sub(p));
    for (const a of ancestorsOf(p)) {
      // Only the ancestors strictly inside the write root: re-denying the root
      // itself would block unrelated work in the project.
      if (isUnder(a, under)) filters.add(literal(a));
    }
  }
  return rule('deny', ['file-write-unlink'], [...filters]);
}

/**
 * @param {object} policy resolved by src/sandbox/policy.js
 * @param {{command:string,cwd:string,tmpDir?:string|null,shell?:string}} opts
 * @returns {{ file: string, args: string[] }}
 */
export function buildSeatbeltCommand(policy, { command, cwd, tmpDir = null, shell = SHELL } = {}) {
  const profile = [
    '(version 1)',
    // No `(with message …)`: that writes into the sandbox violation log store
    // and needs its own permission story (plan §10). Denials are read back off
    // the command's stderr instead, like the Linux side.
    '(deny default)',
    '',
    '; Runtime floor — a /bin/bash process cannot start without these.',
    ...RUNTIME_ALLOWS,
    '',
    '; Network',
    // Unix domain sockets are denied unless the network has been granted — see
    // networkSection() for why DNS needs one.
    ...networkSection(policy),
    '',
    '; File read',
    ...readSection(policy),
    '',
    '; File write',
    ...writeSection(policy, tmpDir),
    '',
  ];

  const tail = readDenyUnlinkTail(policy);
  if (tail.length) profile.push('; Read-denied paths inside write roots stay in place', ...tail, '');

  // The private temp dir must also be READABLE, not just writable, or a build
  // tool cannot read back what it just wrote there.
  if (tmpDir && policy.read.profile !== 'hide') {
    profile.push(`(allow file-read* ${sub(tmpDir)})`);
  }

  // `-p` takes the profile as ONE argv element; the command after the profile is
  // exec'd directly, so the model's command never passes through a shell twice.
  return { file: EXEC, args: ['-p', profile.join('\n'), shell, '-c', command] };
}

// What this backend cannot do that the policy asks for. Surfaced by /sandbox and
// doctor rather than silently ignored.
export function seatbeltLimitations(policy) {
  const out = policy.unsupported.map((u) => `${u.in}: ${u.entry} — ${u.why}`);
  if (policy.network === 'ask') {
    out.push('network "ask" is granted only for commands the user approves; in yolo mode (no prompts) it stays off');
  }
  out.push('network "on" is NOT available on macOS in v1: name resolution does not come back up inside a Seatbelt sandbox (measured — even with every mach service and unix socket allowed). Egress therefore needs the sandbox-external proxy of Phase 3, which also brings per-domain control; until then use "off" or "ask"');
  if (policy.read.profile === 'hide') {
    out.push('read profile "hide": reads are open outside the denied paths (credentials are still unreachable)');
  }
  out.push('sandbox-exec is deprecated by Apple but is still the only per-process primitive macOS ships; it is expected to keep working');
  return out;
}

export const SEATBELT_SHELL = SHELL;