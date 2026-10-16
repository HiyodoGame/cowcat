// Phase 1 of the system-level sandbox: policy resolution, bwrap argv generation,
// command planning and violation reporting.
//
// Everything here is deliberately testable WITHOUT Linux or bubblewrap: argv
// generation is a pure function, the plan takes an injected probe verdict, and
// the policy touches the filesystem only to look up a fixture directory. The
// real enforcement test lives in test/sandbox-linux.test.mjs and runs where
// bubblewrap actually exists (CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { canonicalPath } from '../src/canonical.js';
import { normalizeSandbox, expandPath, worktreeSiblings } from '../src/sandbox/policy.js';
import { buildBwrapCommand, bwrapLimitations, WORKSPACE_READ_PATHS, BWRAP_SHELL } from '../src/sandbox/backends/bwrap.js';
import { planBashCommand, shellQuote, toShellCommand, effectiveSandbox } from '../src/sandbox/exec.js';
import { detectViolations, sandboxNote, sanitizeLine } from '../src/sandbox/violations.js';

const probeWith = (name, usable = true) => ({
  platform: 'linux',
  usable: usable ? name : null,
  backends: [{ name, usable, reason: usable ? 'ok' : 'missing', detail: usable ? `/usr/bin/${name}` : 'not found', fix: null }],
  notes: [],
});

// Fixtures are CANONICAL because the product is. See the note above.
const TMP = canonicalPath(tmpdir());

const tempProject = (siblings = []) => {
  const parent = canonicalPath(mkdtempSync(join(TMP, 'cowcat-pol-')));
  const cwd = join(parent, 'proj');
  mkdirSync(cwd);
  for (const s of siblings) mkdirSync(join(parent, s));
  return { parent, cwd, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
};

// ─────────────────────────────── policy

test('normalizeSandbox: legacy string modes keep their meaning', () => {
  assert.equal(normalizeSandbox({ sandbox: 'off' }).mode, 'off');
  assert.equal(normalizeSandbox({ sandbox: 'light' }).mode, 'light');
  assert.equal(normalizeSandbox({}).mode, 'light', 'unset stays light');
  assert.equal(normalizeSandbox({ sandbox: 'nonsense' }).mode, 'light', 'unknown degrades to light');
});

test('normalizeSandbox: object form and env denylist keep working', () => {
  const p = normalizeSandbox({ sandbox: { mode: 'system', envDeny: ['FOO_TOKEN'] } });
  assert.equal(p.mode, 'system');
  assert.deepEqual(p.envDeny, ['FOO_TOKEN']);
  const legacy = normalizeSandbox({ sandbox: { envDeny: ['/^BAR_/'] } });
  assert.equal(legacy.mode, 'light');
  assert.deepEqual(legacy.envDeny, ['/^BAR_/']);
  assert.deepEqual(normalizeSandbox({ sandboxEnvDeny: ['BAZ'] }).envDeny, ['BAZ'], 'flat legacy key still read');
});

test('normalizeSandbox: defaults deny credentials, allow the project, and keep the host tmpdir OUT', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const p = normalizeSandbox({ sandbox: 'system' }, { cwd });
    assert.ok(p.read.deny.includes(canonicalPath(join(homedir(), '.ssh'))));
    assert.ok(p.read.deny.includes(canonicalPath(join(homedir(), '.cowcat'))));
    assert.ok(p.read.allow.includes(cwd));
    assert.ok(p.write.allow.includes(cwd));
    // The sandbox gets a private /tmp from the backend instead: binding the
    // host's temp dir back in would expose every other process's scratch files
    // (and silently undo the private tmpfs). Caught by CI on the first run.
    assert.ok(!p.write.allow.includes(TMP), 'the host temp directory is not writable by default');
    assert.equal(p.network, 'off');
    assert.equal(p.read.profile, 'workspace');
    assert.equal(p.failOpen, true);
    assert.deepEqual(p.unsupported, []);
  } finally { cleanup(); }
});

test('normalizeSandbox: globs are collected as unsupported instead of being silently dropped', () => {
  const p = normalizeSandbox({ sandbox: { mode: 'system', read: { deny: ['**/.env'] } } });
  assert.equal(p.read.deny.length, 0);
  assert.equal(p.unsupported.length, 1);
  assert.match(p.unsupported[0].why, /glob/);
});

test('normalizeSandbox: failOpen and read.profile are opt-out, backend/network validated', () => {
  const p = normalizeSandbox({ sandbox: { mode: 'system', failOpen: false, network: 'bogus', backend: 'bogus', read: { profile: 'hide' } } });
  assert.equal(p.failOpen, false);
  assert.equal(p.network, 'off');
  assert.equal(p.backend, 'auto');
  assert.equal(p.read.profile, 'hide');
});

test('worktreeSiblings: sibling worktrees become writable (found in src/worktree.js:38)', () => {
  const { cwd, cleanup } = tempProject(['proj-cowcat-abc', 'proj-cowcat-def', 'unrelated']);
  try {
    const sibs = worktreeSiblings(cwd);
    assert.equal(sibs.length, 2);
    assert.ok(sibs.every((p) => p.includes('proj-cowcat-')));
    const p = normalizeSandbox({ sandbox: 'system' }, { cwd });
    for (const s of sibs) assert.ok(p.write.allow.includes(s), `${s} must be writable`);
  } finally { cleanup(); }
});

test('expandPath: ~, ~/x and relative entries all resolve', () => {
  const cwd = '/tmp/base';
  assert.equal(expandPath('~', cwd), canonicalPath(resolve(homedir())));
  assert.equal(expandPath('~/.ssh', cwd), canonicalPath(resolve(join(homedir(), '.ssh'))));
  // Relative entries come out canonical too, which on macOS is visible right
  // here: `/tmp` is a symlink to `/private/tmp`, so the answer is
  // `/private/tmp/base/sub/dir`. That is the whole point — Seatbelt matches the
  // path the kernel reports, not the one the user typed.
  assert.equal(expandPath('sub/dir', cwd), canonicalPath(resolve(cwd, 'sub/dir')));
  assert.equal(expandPath('', cwd), null);
  assert.equal(expandPath(null, cwd), null);
});

// ─────────────────────────────── bwrap argv

const policyFor = (cwd, over = {}) => normalizeSandbox({ sandbox: { mode: 'system', ...over } }, { cwd });

// Injected filesystem view: on Windows the system paths do not exist, and a
// builder that consults the real FS would skip them — the test would pass while
// asserting nothing.
const fakeFs = ({ dirs = [], files = [] } = {}) => ({
  isDir: (p) => dirs.includes(p),
  isFile: (p) => files.includes(p),
  exists: (p) => dirs.includes(p) || files.includes(p),
});

test('buildBwrapCommand: network off is a namespace flag, not an env var', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP] });
    const off = buildBwrapCommand(policyFor(cwd), { command: 'echo hi', cwd, fs });
    assert.ok(off.args.includes('--unshare-net'));
    const on = buildBwrapCommand(policyFor(cwd, { network: 'on' }), { command: 'echo hi', cwd, fs });
    assert.ok(!on.args.includes('--unshare-net'));
  } finally { cleanup(); }
});

test('buildBwrapCommand: workspace profile binds only the read surface (no --ro-bind / /)', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP] });
    const { file, args } = buildBwrapCommand(policyFor(cwd), { command: 'ls', cwd, fs });
    assert.equal(file, 'bwrap');
    assert.ok(!args.includes('/'), 'the whole root is never bound in workspace mode');
    for (const p of ['/usr', '/etc']) assert.ok(args.includes(p), `${p} is readable`);
    assert.ok(args.includes(cwd), 'the project is readable');
  } finally { cleanup(); }
});

test('buildBwrapCommand: denied reads are hidden (dir → tmpfs, file → /dev/null)', () => {
  const { parent, cwd, cleanup } = tempProject();
  try {
    const secretDir = join(parent, 'secretdir');
    const secretFile = join(parent, 'secretfile');
    const absent = join(parent, 'absent');
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP, secretDir], files: [secretFile] });
    const p = policyFor(cwd, { read: { deny: [secretDir, secretFile, absent] } });
    const { args } = buildBwrapCommand(p, { command: 'ls', cwd, fs });
    const i = args.indexOf(secretDir);
    assert.equal(args[i - 1], '--tmpfs');
    const j = args.indexOf(secretFile);
    assert.equal(args[j - 2], '--ro-bind');
    assert.equal(args[j - 1], '/dev/null');
    assert.ok(!args.includes(absent), 'missing paths are skipped, not invented');
  } finally { cleanup(); }
});

test('buildBwrapCommand: writes are allow-only, and write-deny rebinds read-only (contents preserved)', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const hooks = join(cwd, '.git', 'hooks');
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP, hooks] });
    const p = policyFor(cwd, { write: { deny: [hooks] } });
    const { args } = buildBwrapCommand(p, { command: 'ls', cwd, fs });
    assert.ok(args.includes('--bind'), 'allowed paths are bound read-write');
    // A bind is [flag, src, dest] with src === dest here, so the pair sits at
    // (i-1, i, i+1) — indexOf, not lastIndexOf, names the first half.
    const k = args.indexOf(hooks);
    assert.equal(args[k - 1], '--ro-bind', 'a denied write path is rebound read-only');
    assert.equal(args[k + 1], hooks, 'and the destination is the same path');
  } finally { cleanup(); }
});

test('buildBwrapCommand: the sandbox always gets its own /tmp (both read profiles)', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP] });
    for (const profile of ['workspace', 'hide']) {
      const { args } = buildBwrapCommand(policyFor(cwd, { read: { profile } }), { command: 'ls', cwd, fs });
      const i = args.indexOf('/tmp');
      assert.equal(args[i - 1], '--tmpfs', `${profile}: /tmp must be a fresh private tmpfs`);
    }
    // A user who explicitly asks for the host temp directory gets it bound over
    // the tmpfs (the documented escape) — but only by asking.
    const { args } = buildBwrapCommand(policyFor(cwd, { write: { allow: [TMP] } }), { command: 'ls', cwd, fs });
    assert.ok(args.includes('--bind') && args.includes(TMP), 'explicit host tmp grant is honoured');
  } finally { cleanup(); }
});

test('buildBwrapCommand: hide profile keeps the open-read behaviour behind an opt-out', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP] });
    const { args } = buildBwrapCommand(policyFor(cwd, { read: { profile: 'hide' } }), { command: 'ls', cwd, fs });
    const i = args.indexOf('--ro-bind');
    assert.equal(args[i + 1], '/');
    assert.equal(args[i + 2], '/');
  } finally { cleanup(); }
});

test('buildBwrapCommand: always ends with the shell invocation, detached and non-interactive', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const fs = fakeFs({ dirs: [...WORKSPACE_READ_PATHS, cwd, TMP] });
    const { args } = buildBwrapCommand(policyFor(cwd), { command: 'echo hi', cwd, fs });
    assert.deepEqual(args.slice(-6), ['--chdir', cwd, '--', BWRAP_SHELL, '-c', 'echo hi']);
    assert.ok(args.includes('--die-with-parent'));
    assert.ok(args.includes('--new-session'));
  } finally { cleanup(); }
});

test('bwrapLimitations: reports what v1 cannot express instead of pretending', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const p = policyFor(cwd, { network: 'ask', read: { profile: 'hide', deny: ['**/.env'] } });
    const limits = bwrapLimitations(p);
    assert.ok(limits.some((l) => /glob/.test(l)));
    assert.ok(limits.some((l) => /network "ask"/.test(l)));
    assert.ok(limits.some((l) => /read profile "hide"/.test(l)));
  } finally { cleanup(); }
});

// ─────────────────────────────── planning

test('planBashCommand: light/off stay untouched (no wrapper at all)', () => {
  for (const mode of ['off', 'light']) {
    const policy = normalizeSandbox({ sandbox: mode });
    assert.equal(planBashCommand({ policy, probe: probeWith('bwrap'), command: 'ls', cwd: '/tmp' }).kind, 'plain');
  }
});

test('planBashCommand: system + usable bwrap → wrapped with argv', () => {
  const { cwd, cleanup } = tempProject();
  try {
    const plan = planBashCommand({ policy: policyFor(cwd), probe: probeWith('bwrap'), command: 'echo hi', cwd });
    assert.equal(plan.kind, 'wrapped');
    assert.equal(plan.backend, 'bwrap');
    assert.equal(plan.file, 'bwrap');
    assert.ok(Array.isArray(plan.args) && plan.args.length > 5);
  } finally { cleanup(); }
});

test('planBashCommand: no usable backend → unavailable, carrying the fix for the UI', () => {
  const probe = { platform: 'linux', usable: null, backends: [{ name: 'bwrap', usable: false, reason: 'userns-blocked', detail: 'uid map denied', fix: 'install the AppArmor profile' }], notes: [] };
  const plan = planBashCommand({ policy: normalizeSandbox({ sandbox: 'system' }), probe, command: 'ls', cwd: '/tmp' });
  assert.equal(plan.kind, 'unavailable');
  assert.equal(plan.reason, 'userns-blocked');
  assert.match(plan.fix, /AppArmor/);
});

test('planBashCommand: a capable-but-unimplemented backend must NOT run unsandboxed', () => {
  // `seatbelt` used to be this fixture (Phase 2 had not landed). It is
  // implemented now, so the contract is pinned with a backend that does not
  // exist: the point is "capable but not driven by this build", not a name.
  const policy = normalizeSandbox({ sandbox: 'system' });
  const plan = planBashCommand({ policy, probe: probeWith('mxc'), command: 'ls', cwd: '/tmp' });
  assert.equal(plan.kind, 'unavailable');
  assert.equal(plan.reason, 'backend-not-implemented', 'a backend we cannot drive is not a silent pass-through');
  assert.match(plan.detail, /does not drive it yet/);
});

test('planBashCommand: forcing a backend that cannot run must fail instead of degrading quietly', () => {
  const probe = { platform: 'linux', usable: null, backends: [{ name: 'bwrap', usable: false, reason: 'missing', detail: 'bwrap not found', fix: 'apt-get install bubblewrap' }], notes: [] };
  const policy = normalizeSandbox({ sandbox: { mode: 'system', backend: 'bwrap' } });
  const plan = planBashCommand({ policy, probe, command: 'ls', cwd: '/tmp' });
  assert.equal(plan.kind, 'unavailable');
  assert.equal(plan.reason, 'missing');
});

// ─────────────────────────────── what is actually in effect

test('effectiveSandbox: the label never claims a sandbox that is not running', () => {
  const bare = { platform: 'linux', usable: null, backends: [{ name: 'bwrap', usable: false, reason: 'userns-blocked', detail: 'uid map denied', fix: 'install the profile' }], notes: [] };
  const ok = probeWith('bwrap');

  const light = effectiveSandbox({ sandbox: 'light' }, { probe: ok });
  assert.equal(light.label, 'light');
  assert.equal(light.active, true, 'light still strips env, so it is "active" in its own sense');

  const off = effectiveSandbox({ sandbox: 'off' }, { probe: ok });
  assert.equal(off.active, false);
  assert.equal(off.label, 'off');

  const active = effectiveSandbox({ sandbox: 'system' }, { probe: ok });
  assert.equal(active.active, true);
  assert.equal(active.backend, 'bwrap');
  assert.equal(active.label, 'system · bwrap');

  const degraded = effectiveSandbox({ sandbox: 'system' }, { probe: bare });
  assert.equal(degraded.active, false);
  assert.match(degraded.label, /unavailable → light/);
  assert.equal(degraded.reason, 'userns-blocked');
  assert.match(degraded.fix, /profile/);

  const refusing = effectiveSandbox({ sandbox: { mode: 'system', failOpen: false } }, { probe: bare });
  assert.match(refusing.label, /unavailable → blocked/);
});

// ─────────────────────────────── background shell quoting

test('shellQuote: safe words pass through, everything else is single-quoted', () => {
  assert.equal(shellQuote('bwrap'), 'bwrap');
  assert.equal(shellQuote('/usr/bin/x-y_z'), '/usr/bin/x-y_z');
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(''), "''");
  assert.equal(toShellCommand('bwrap', ['--chdir', '/a b', '--', '/bin/bash', '-c', "echo 'x'"]),
    `bwrap --chdir '/a b' -- /bin/bash -c 'echo '\\''x'\\'''`);
});

// ─────────────────────────────── violations

test('detectViolations: maps the sandboxed command\'s own errors to violation kinds', () => {
  const stderr = [
    'cat: /home/u/.ssh/id_rsa: Permission denied',
    'sh: 1: cannot create /etc/x: Read-only file system',
    'curl: (6) Could not resolve host: example.com',
  ].join('\n');
  const v = detectViolations(stderr);
  assert.deepEqual(v.map((x) => x.kind), ['fs-read', 'fs-write', 'net']);
  assert.match(v[0].target, /id_rsa/);
});

test('detectViolations: hidden paths look like missing ones and are still reported', () => {
  const v = detectViolations('ls: cannot access \'/home/u/.ssh\': No such file or directory');
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'fs-read');
});

test('detectViolations: caps the number of entries', () => {
  const v = detectViolations('Permission denied\n'.repeat(20), { limit: 3 });
  assert.equal(v.length, 3);
});

test('sandboxNote: names the mode and forbids working around the boundary', () => {
  const policy = normalizeSandbox({ sandbox: 'system' });
  const note = sandboxNote({ policy, backend: 'bwrap', violations: [{ kind: 'fs-read', target: '~/.ssh' }], limitations: [] });
  assert.match(note, /system mode \(bwrap\)/);
  assert.match(note, /fs-read/);
  assert.match(note, /do not try to work around it/);
  assert.equal(sandboxNote({ policy: normalizeSandbox({ sandbox: 'light' }), violations: [] }), '', 'light mode says nothing');
});

test('sanitizeLine: strips control/invisible characters and caps the length', () => {
  assert.equal(sanitizeLine('a\u0000b\u200bc\nd'), 'a b c d');
  assert.equal(sanitizeLine('<b>t</b>'), 'bt/b', 'angle brackets are removed so the note cannot be spoofed as markup');
  assert.equal(sanitizeLine('x'.repeat(600)).length, 501);
});
