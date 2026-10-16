// Phase 0 of the system-level sandbox: backend preflight classification.
//
// The real probe spawns `bwrap` / `sandbox-exec`, so the tests inject the
// lookup and the runner instead of depending on what the CI host happens to
// have installed. What we assert is the CLASSIFICATION: the same failure text
// must map to the same reason and the same fix, on every machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, probeBackends, sandboxProbe, formatSandboxProbe, sandboxProbeSummary } from '../src/sandbox/probe.js';

const whichFound = (path = '/usr/bin/bwrap') => () => path;
const whichMissing = () => null;
const runOk = () => ({ ok: true, stderr: '' });
const runFail = (stderr) => () => ({ ok: false, stderr });

const fakeRun = () => { throw new Error('runner must not be called'); };

test('detectPlatform: maps node platforms and WSL apart', () => {
  assert.equal(detectPlatform({}, 'win32'), 'win32');
  assert.equal(detectPlatform({}, 'darwin'), 'darwin');
  assert.equal(detectPlatform({}, 'linux'), 'linux');
  assert.equal(detectPlatform({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), 'wsl');
  assert.equal(detectPlatform({ WSL_INTEROP: '/run/WSL/8_interop' }, 'linux'), 'wsl');
  assert.equal(detectPlatform({}, 'freebsd'), 'other');
});

test('linux: bwrap present and runnable → usable', () => {
  const p = probeBackends({ platform: 'linux', which: whichFound(), run: runOk });
  assert.equal(p.usable, 'bwrap');
  assert.equal(p.backends[0].reason, 'ok');
  assert.equal(p.backends[0].fix, null);
});

test('linux: bwrap missing → missing + install hint, and the runner is never called', () => {
  const p = probeBackends({ platform: 'linux', which: whichMissing, run: fakeRun });
  const b = p.backends[0];
  assert.equal(p.usable, null);
  assert.equal(b.reason, 'missing');
  assert.match(b.fix, /apt-get install bubblewrap/);
});

test('linux: blocked user namespace → userns-blocked + AppArmor fix', () => {
  // Real text from Ubuntu 24.04, where the AppArmor restriction makes bwrap fail
  // before it can create the mapping (Launchpad #2046844 / bubblewrap #632).
  const p = probeBackends({
    platform: 'linux',
    which: whichFound(),
    run: runFail('bwrap: setting up uid map: Permission denied\n'),
  });
  const b = p.backends[0];
  assert.equal(b.reason, 'userns-blocked');
  assert.match(b.detail, /uid map/);
  assert.match(b.fix, /apparmor_parser/);
});

test('linux: any other bwrap failure keeps the raw first line for the user', () => {
  const p = probeBackends({
    platform: 'linux',
    which: whichFound(),
    run: runFail('bwrap: execvp true: No such file or directory\nsecond line\n'),
  });
  const b = p.backends[0];
  assert.equal(b.reason, 'error');
  assert.equal(b.detail, 'bwrap: execvp true: No such file or directory');
  assert.equal(b.fix, null);
});

test('wsl is treated as linux for probing (same backend, different fix note)', () => {
  const p = probeBackends({ platform: 'wsl', which: whichFound(), run: runOk });
  assert.equal(p.usable, 'bwrap');
  assert.match(p.notes.join(' '), /inside the distro/);
});

test('darwin: seatbelt usable / missing', () => {
  const ok = probeBackends({ platform: 'darwin', which: whichFound('/usr/bin/sandbox-exec'), run: runOk });
  assert.equal(ok.usable, 'seatbelt');
  const bad = probeBackends({ platform: 'darwin', which: whichMissing, run: fakeRun });
  assert.equal(bad.usable, null);
  assert.equal(bad.backends[0].reason, 'missing');
});

test('win32: reports unsupported without spawning anything, and offers the two ways out', () => {
  const p = probeBackends({ platform: 'win32', which: () => { throw new Error('no lookup on windows'); }, run: fakeRun });
  assert.equal(p.usable, null);
  assert.equal(p.backends[0].reason, 'unsupported-platform');
  assert.match(p.backends[0].fix, /WSL2/);
  assert.match(p.backends[0].fix, /Docker Sandboxes/);
  assert.match(p.notes.join(' '), /native Windows/);
});

test('formatSandboxProbe: unavailable backends print reason + fix, available ones do not', () => {
  const unusable = formatSandboxProbe(probeBackends({ platform: 'linux', which: whichMissing, run: fakeRun }));
  assert.ok(unusable.some((l) => /unavailable \[missing\]/.test(l)));
  assert.ok(unusable.some((l) => l.startsWith('  fix: ')));
  assert.ok(unusable.includes('platform: linux'));

  const usable = formatSandboxProbe(probeBackends({ platform: 'darwin', which: whichFound('/usr/bin/sandbox-exec'), run: runOk }));
  assert.ok(usable.some((l) => /backend: seatbelt — usable \(/.test(l)));
  assert.ok(!usable.some((l) => l.startsWith('  fix: ')));
});

test('sandboxProbe: memoized, and force re-probes', () => {
  const a = sandboxProbe({ force: true });
  const b = sandboxProbe();
  assert.equal(a, b);
  // Shape assertions only: what this host actually supports is a live fact, and
  // asserting it here would make the suite depend on the machine.
  assert.ok(['linux', 'wsl', 'darwin', 'win32', 'other'].includes(b.platform));
  assert.ok(Array.isArray(b.backends) && b.backends.length >= 1);
  assert.match(sandboxProbeSummary(b), /system sandbox (available|unavailable)/);
});
