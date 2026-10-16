// Seatbelt profile generation: pure logic, runs everywhere.
//
// The real enforcement assertions live in test/sandbox-macos.test.mjs and only
// run on a machine with `sandbox-exec`. Everything here is about the profile
// TEXT: that the rules exist, that they are in the order Seatbelt evaluates them
// (last match wins), and that the argv shape is what `sandbox-exec` expects.
//
// The ordering assertions are the point. A profile with the right rules in the
// wrong order denies nothing, and nothing but a macOS run would notice.
//
// The policy is hand-built with macOS-shaped literal paths rather than produced
// by normalizeSandbox() against the real filesystem: expandPath() canonicalizes
// (src/canonical.js), so a policy derived here on Windows would carry `F:\proj`
// and every assertion would quietly be testing Windows. A profile generator is a
// pure function of its input and deserves input that does not depend on where
// the test happens to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeatbeltCommand, seatbeltLimitations, SEATBELT_SHELL, SEATBELT_READ_PATHS } from '../src/sandbox/backends/seatbelt.js';
import { planBashCommand } from '../src/sandbox/exec.js';

const HOME = '/Users/dev';
const PROJ = '/Users/dev/proj';

const policyFor = (over = {}) => ({
  mode: 'system',
  envDeny: [],
  network: 'off',
  failOpen: true,
  backend: 'auto',
  read: {
    profile: 'workspace',
    // normalizeSandbox() always puts the session cwd at the head of read.allow;
    // this fixture mirrors that, because a project that cannot be read is not a
    // policy worth generating.
    deny: [`${HOME}/.ssh`, `${HOME}/.aws`],
    allow: [PROJ, `${HOME}/.gitconfig`],
  },
  write: { allow: [PROJ], deny: [`${PROJ}/.env`] },
  unsupported: [],
  ...over,
});

const profileOf = (policy, opts = {}) => buildSeatbeltCommand(policy, { command: 'ls', cwd: PROJ, ...opts }).args[1];

// Does the rule block starting at `header` mention `path`? SBPL rules are
// multi-line (`(allow file-read*\n  (subpath …)\n)`), so a single-line regex
// over the whole profile is the wrong instrument — it silently fails to match
// and the test would be asserting nothing.
//
// The block ends at a line that is exactly `)`. Ending at "the first line that
// ends with )" is the trap: `(subpath "…")` is itself such a line, so that
// version stops one line into the rule and reports false negatives.
function blockContaining(profile, header, path) {
  const lines = profile.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(header)) continue;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j].includes(`"${path}"`)) return true;
      if (lines[j].trim() === ')') break;
    }
  }
  return false;
}

const indexOf = (profile, re) => profile.split('\n').findIndex((l) => re.test(l));
const lastIndexOf = (profile, re) => profile.split('\n').reduce((acc, l, i) => (re.test(l) ? i : acc), -1);

const seatbeltProbe = {
  platform: 'darwin',
  usable: 'seatbelt',
  backends: [{ name: 'seatbelt', usable: true, reason: 'ok', detail: '/usr/bin/sandbox-exec', fix: null }],
  notes: [],
};

test('argv: sandbox-exec -p <profile> <shell> -c <command>', () => {
  const built = buildSeatbeltCommand(policyFor(), { command: 'echo hi', cwd: PROJ });
  assert.equal(built.file, '/usr/bin/sandbox-exec');
  assert.equal(built.args[0], '-p');
  assert.equal(built.args[2], SEATBELT_SHELL);
  assert.deepEqual(built.args.slice(3), ['-c', 'echo hi']);
  // The model's command is an argv element AFTER the profile, never text glued
  // into it: no shell re-parsing of quotes or flags.
  assert.ok(!built.args[1].includes('echo hi'));
});

test('profile: starts with (version 1) and (deny default)', () => {
  const lines = profileOf(policyFor()).split('\n');
  assert.equal(lines[0], '(version 1)');
  assert.equal(lines[1], '(deny default)');
});

test('profile: the runtime floor a /bin/bash process needs to start at all', () => {
  const p = profileOf(policyFor());
  // Without these, dyld/bash abort before the command ever runs. Measured on a
  // real macOS host: a missing read grant shows up as SIGABRT with no stderr,
  // not as an EPERM on the call you would expect.
  for (const need of ['process-exec', 'process-fork', 'ipc-posix-shm', 'user-preference-read', 'system-socket']) {
    assert.ok(p.includes(`(allow ${need}`), `${need} is allowed`);
  }
  assert.match(p, /\(allow sysctl-read[\s\S]*sysctl-name "hw\.ncpu"/);
  assert.ok(p.indexOf('(allow sysctl-read') < p.indexOf('; File read'), 'the floor comes before the filesystem rules');
});

test('read paths are KERNEL paths, not the spelling a person would type', () => {
  // This has now cost three CI round trips, all the same way: on macOS `/etc`,
  // `/var` and `/tmp` are symlinks into `/private`, so `(subpath "/var/db")` or
  // `(subpath "/etc")` grants NOTHING — and because a missing read grant is not an
  // EPERM but a dyld SIGABRT (or, for resolv.conf, an ENOTFOUND), it presents as
  // something that looks unrelated.
  const SYMLINKED = new Set(['/etc', '/var', '/tmp']);
  for (const p of SEATBELT_READ_PATHS) {
    assert.ok(!SYMLINKED.has(p), `${p} is a symlinked spelling; Seatbelt matches the kernel's view`);
  }
  assert.ok(SEATBELT_READ_PATHS.includes('/private/var/db'), 'the dyld shared cache must be readable');
  assert.ok(SEATBELT_READ_PATHS.includes('/private/etc'), 'resolv.conf lives under /private/etc');
});

test('reads: workspace profile allow-lists, and credential denies come AFTER every allow', () => {
  const p = profileOf(policyFor());
  assert.ok(blockContaining(p, 'allow file-read*', PROJ), 'the project is readable');
  assert.ok(blockContaining(p, 'deny file-read*', `${HOME}/.ssh`), 'credentials are read-denied');
  const allowAt = indexOf(p, /\(allow file-read\*/);
  const denyAt = indexOf(p, /\(deny file-read\*/);
  assert.ok(denyAt > allowAt, `Seatbelt is last-match-wins: deny (${denyAt}) must follow the read allow (${allowAt})`);
});

test('reads: the root inode is re-allowed, or dyld aborts before exec', () => {
  // Measured on macOS 15: `(allow file-read* (subpath …))` does not cover `/`,
  // `(deny default)` still denies it, and the process dies with SIGABRT and no
  // stderr. A blanket `(allow file-read*)` covers the root implicitly, which is
  // why the hide profile worked and the workspace profile did not.
  const p = profileOf(policyFor());
  assert.ok(p.includes('(allow file-read* (literal "/"))'), 'the root inode must be re-allowed');
  // And it must come AFTER the credential denies, or it would undo them for any
  // path directly under the root.
  const rootAt = indexOf(p, /\(allow file-read\* \(literal "\/"\)\)/);
  const denyAt = indexOf(p, /\(deny file-read\*/);
  assert.ok(rootAt > denyAt, 'the root re-allow must not precede the credential denies');
  // The hide profile grants the root already. Match the whole line: the
  // move-blocking rules also emit `(literal "/")` as the last pin in an
  // ancestor chain, and a bare substring check matches that instead.
  const hide = profileOf(policyFor({ read: { profile: 'hide', deny: [`${HOME}/.ssh`], allow: [] } }));
  assert.ok(
    !hide.split('\n').includes('(allow file-read* (literal "/"))'),
    'the hide profile needs no root re-allow',
  );
});

test('reads: directory metadata is allowed, and AFTER the denies', () => {
  const p = profileOf(policyFor());
  const denyAt = indexOf(p, /\(deny file-read\*/);
  const metaAt = indexOf(p, /\(allow file-read-metadata/);
  assert.ok(metaAt > denyAt, 'realpath() traversal must not re-open a denied subtree');
  assert.match(p, /\(allow file-read-metadata\s+\(vnode-type DIRECTORY\)\)/);
});

test('reads: the hide profile opens reads and still denies the credentials', () => {
  const p = profileOf(policyFor({ read: { profile: 'hide', deny: [`${HOME}/.ssh`], allow: [] } }));
  assert.match(p, /\(allow file-read\*\)/);
  assert.ok(blockContaining(p, 'deny file-read*', `${HOME}/.ssh`));
});

test('network: off emits no allow at all, so (deny default) governs', () => {
  const off = profileOf(policyFor());
  assert.ok(!/\(allow network/.test(off), 'a client that ignores proxy env vars must still be blocked');
  assert.ok(!off.includes('AF_UNIX'), 'unix sockets stay closed while the network is off');
  const on = profileOf(policyFor({ network: 'on' }));
  assert.match(on, /\(allow network\*\)/);
});

test('network: "on" also opens the DNS socket, or every lookup fails ENOTFOUND', () => {
  // macOS resolves names through mDNSResponder over a LOCAL unix socket, not to
  // port 53. Granting egress without this looks like "the network is broken".
  // It is the only unix socket the profile ever opens, and only once the network
  // has been granted.
  const on = profileOf(policyFor({ network: 'on' }));
  assert.match(on, /\(allow network-outbound \(remote unix-socket \(subpath "\/private\/var\/run\/mdnsd"\)\)\)/);
  assert.match(on, /\(allow system-socket \(socket-domain AF_UNIX\)\)/);
  // The kernel spelling: /var is a symlink to /private/var on macOS. Match the
  // QUOTED string — "/private/var/run/mdnsd" contains "/var/run/mdnsd" as a
  // substring, so a bare `includes` reports the one correct spelling as wrong.
  assert.ok(!on.includes('"/var/run/mdnsd"'), 'the symlinked spelling would grant nothing');
  // ssh-agent and docker.sock stay closed even with the network on.
  assert.ok(!on.includes('ssh-agent') && !on.includes('docker.sock'));
});

test('network: ask stays off unless this exact call was granted', () => {
  const ask = policyFor({ network: 'ask' });
  const denied = planBashCommand({ policy: ask, probe: seatbeltProbe, command: 'ls', cwd: PROJ });
  assert.ok(!/\(allow network/.test(denied.args[1]), 'unapproved ask stays off');
  assert.equal(denied.network, 'off');
  // The granted call does NOT get a network on seatbelt — see the refusal test
  // below. This assertion is here so that when the proxy of Phase 3 lands, the
  // change of behaviour shows up as one line failing rather than as a surprise.
  const granted = planBashCommand({ policy: ask, probe: seatbeltProbe, command: 'ls', cwd: PROJ, networkGranted: true });
  assert.equal(granted.kind, 'unavailable');
});

test('network: "on" is REFUSED on seatbelt, and not degradable', () => {
  // Measured on macOS 15 (tools/seatbelt-smoke.mjs --net): name resolution never
  // comes back up inside a Seatbelt sandbox — not with the mDNSResponder socket,
  // not with com.apple.discoveryd, not with every mach service and every unix
  // socket allowed, and not even for a numeric IP literal. So "on" would grant a
  // network that does not work.
  //
  // The refusal is what matters, and so is `degradable: false`: falling back to
  // light mode would drop the filesystem isolation while KEEPING the network,
  // which is strictly more access than the user asked for.
  const plan = planBashCommand({ policy: policyFor({ network: 'on' }), probe: seatbeltProbe, command: 'ls', cwd: PROJ });
  assert.equal(plan.kind, 'unavailable');
  assert.equal(plan.reason, 'network-not-supported');
  assert.equal(plan.degradable, false, 'failOpen must not turn this into a light-mode run with network');
  assert.match(plan.detail, /resolution/i, 'the reason names the actual failure');
  assert.match(plan.fix, /off|ask/, 'the fix says what the user can set instead');

  // off and ask still work — the refusal must not take the sandbox down with it.
  assert.equal(planBashCommand({ policy: policyFor(), probe: seatbeltProbe, command: 'ls', cwd: PROJ }).kind, 'wrapped');
  assert.equal(
    planBashCommand({ policy: policyFor({ network: 'ask' }), probe: seatbeltProbe, command: 'ls', cwd: PROJ }).kind,
    'wrapped',
  );
});

test('writes: allow-only, with the deny list after the allows', () => {
  const p = profileOf(policyFor());
  assert.ok(blockContaining(p, 'allow file-write*', PROJ));
  assert.ok(blockContaining(p, 'deny file-write*', `${PROJ}/.env`));
  const allowAt = indexOf(p, /\(allow file-write\*/);
  const denyAt = indexOf(p, /\(deny file-write\*/);
  assert.ok(denyAt > allowAt, `write deny (${denyAt}) must follow the write allow (${allowAt})`);
});

test('writes: unlink/create is re-opened for the write roots', () => {
  // A specific `(deny file-write-unlink …)` outranks a later wildcard
  // `(allow file-write*)`, so without this explicit re-allow `rm` inside the
  // project is impossible.
  assert.ok(blockContaining(profileOf(policyFor()), 'allow file-write-unlink file-write-create', PROJ));
});

test('mv cannot defeat a read deny: unlink/create blocked on the denied paths and their parents', () => {
  const p = profileOf(policyFor());
  assert.ok(blockContaining(p, 'deny file-write-unlink file-write-create', `${HOME}/.ssh`));
  // The directories holding a denied path are pinned too, so the directory
  // cannot be renamed out from under the deny.
  assert.ok(p.includes(`(literal ${JSON.stringify(HOME)})`), `the home directory is pinned: ${HOME}`);
  assert.ok(p.includes(`(literal "/Users")`), 'and so is its parent');
});

test('a read-denied path inside a write root is re-denied LAST, after the write allows', () => {
  const p = profileOf(policyFor({
    read: { profile: 'workspace', deny: [`${PROJ}/secrets`], allow: [] },
    write: { allow: [PROJ], deny: [] },
  }));
  const tail = lastIndexOf(p, /\(deny file-write-unlink/);
  const writeAllow = indexOf(p, /\(allow file-write-unlink file-write-create/);
  assert.ok(tail > writeAllow, `the tail re-deny (${tail}) must come after the write re-allow (${writeAllow})`);
  assert.ok(blockContaining(p, 'deny file-write-unlink', `${PROJ}/secrets`), 'the denied path itself is re-denied');
  // The write root itself is NOT re-denied — that would block unrelated work.
  const tailBlock = p.split('\n').slice(tail).join('\n');
  assert.ok(!tailBlock.includes(`(literal ${JSON.stringify(PROJ)})`), 'the project root stays writable');
});

test('a read-denied path OUTSIDE any write root needs no tail rule', () => {
  const p = profileOf(policyFor());
  assert.equal(p.split('\n').slice(lastIndexOf(p, /\(deny file-write-unlink/)).join('\n').includes('secrets'), false);
  // `~/.ssh` is outside the project, so the read section's own block already
  // holds and a tail rule would only add noise.
  const sections = p.split('; Read-denied paths inside write roots');
  assert.equal(sections.length, 1, 'no tail section is emitted');
});

test('private temp: writable, readable, and never the host temp dir', () => {
  const dir = '/private/tmp/cowcat-sbx-abc';
  const p = profileOf(policyFor(), { tmpDir: dir });
  assert.ok(blockContaining(p, 'allow file-write*', dir), `the private dir must be writable: ${dir}`);
  // Readable too: a build tool that cannot read back its own scratch file is broken.
  assert.ok(blockContaining(p, 'allow file-read*', dir), `the private dir must be readable: ${dir}`);
  assert.ok(!p.includes('/var/folders/'), 'the host per-user temp area stays outside the sandbox');
});

test('private temp: the caller creates it and the plan hands TMPDIR back', () => {
  const dir = '/private/tmp/cowcat-sbx-abc';
  const withDir = planBashCommand({ policy: policyFor(), probe: seatbeltProbe, command: 'ls', cwd: PROJ, tmpDir: dir });
  assert.deepEqual(withDir.env, { TMPDIR: dir });
  const without = planBashCommand({ policy: policyFor(), probe: seatbeltProbe, command: 'ls', cwd: PROJ });
  assert.equal(without.env, undefined, 'bwrap needs no TMPDIR override — it mounts a tmpfs');
});

test('profile size: no single SBPL string literal approaches the 1025-byte limit', () => {
  // sandbox-exec rejects an oversized string with "Error reading string" and
  // then refuses the WHOLE profile — one long path kills the sandbox.
  const long = Array.from({ length: 40 }, (_, i) => `/Users/somebody/a-fairly-long-directory-name-${i}`);
  const p = profileOf(policyFor({
    read: { profile: 'workspace', deny: long.slice(0, 20), allow: long },
    write: { allow: long, deny: [] },
  }));
  for (const line of p.split('\n')) {
    for (const m of line.matchAll(/"([^"]*)"/g)) {
      assert.ok(Buffer.byteLength(m[1]) < 1025, `string literal too long: ${m[1].slice(0, 60)}…`);
    }
  }
});

test('limitations: says what Seatbelt cannot do instead of pretending', () => {
  const ask = seatbeltLimitations(policyFor({ network: 'ask' }));
  assert.ok(ask.some((l) => l.includes('"ask"') && /yolo mode/.test(l)), 'the ask caveat is surfaced');
  assert.ok(ask.some((l) => /network "on" is NOT available/.test(l)), 'the macOS network limit is stated plainly');
  assert.ok(ask.some((l) => /deprecated/.test(l)), 'sandbox-exec deprecation is not hidden');
  const withGlob = seatbeltLimitations(policyFor({ unsupported: [{ in: 'read.deny', entry: '**/.env', why: 'glob patterns are not supported in v1' }] }));
  assert.ok(withGlob.some((l) => /glob/.test(l)), 'glob rules are reported as unsupported');
  const hide = seatbeltLimitations(policyFor({ read: { profile: 'hide', deny: [], allow: [] } }));
  assert.ok(hide.some((l) => /reads are open/.test(l)), 'the hide profile says what it gives up');
});

test('a seatbelt backend is only planned on darwin, and never silently on win32', () => {
  // The probe is the only thing that decides the platform; a forced backend on
  // a platform that has no such primitive must fail loudly, not run bare.
  const forced = planBashCommand({
    policy: policyFor({ backend: 'seatbelt' }),
    probe: { platform: 'win32', usable: null, backends: [{ name: 'none', usable: false, reason: 'unsupported-platform', detail: 'win32', fix: 'use WSL2' }], notes: [] },
    command: 'ls', cwd: PROJ,
  });
  assert.equal(forced.kind, 'unavailable');
  assert.equal(forced.reason, 'unsupported-platform');
});