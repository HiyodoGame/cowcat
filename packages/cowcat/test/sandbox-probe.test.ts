import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeBackends, usableBackend, WINDOWS_ALTERNATIVES, type ProbeHost, type SandboxBackendVerdict } from '../src/index.js';

// The verdict is the product contract here: "not installed", "user namespaces blocked by
// AppArmor" and "the kernel is too old" need three different fixes, so a verdict carries
// `reason`, the error's first line and a copy-pasteable command. These tests assert the
// classification, and that the probe really runs the backend rather than asking its
// version.
function fakeProbe(options: {
  readonly which?: Record<string, string>;
  readonly result?: { code: number; stdout?: string; stderr?: string };
}): { host: ProbeHost; calls: { exe: string; args: readonly string[] }[] } {
  const calls: { exe: string; args: readonly string[] }[] = [];
  return {
    calls,
    host: {
      which: (name) => options.which?.[name] ?? null,
      run: (exe, args) => {
        calls.push({ exe, args });
        const result = options.result;
        return { code: result?.code ?? 0, stdout: '', stderr: result?.stderr ?? '' };
      },
    },
  };
}

// Every platform yields exactly one verdict, so asserting the shape here beats sprinkling
// `?.` over each assertion: a second backend showing up would fail loudly.
function only(verdicts: readonly SandboxBackendVerdict[]): SandboxBackendVerdict {
  assert.equal(verdicts.length, 1);
  const [verdict] = verdicts;
  assert.ok(verdict !== undefined);
  return verdict;
}

test('a missing bubblewrap is diagnosed as missing, with the install command', () => {
  const { host } = fakeProbe({});

  const verdict = only(probeBackends('linux', host));

  assert.equal(verdict.name, 'bwrap');
  assert.equal(verdict.usable, false);
  assert.equal(verdict.reason, 'missing');
  assert.match(verdict.fix ?? '', /apt-get install bubblewrap/);
});

test('bubblewrap is run, not version-checked', () => {
  const { host, calls } = fakeProbe({ which: { bwrap: '/usr/bin/bwrap' } });

  const verdict = only(probeBackends('linux', host));

  assert.equal(verdict.usable, true);
  assert.equal(verdict.reason, 'ok');
  // Installed-and-broken is the whole case this probe exists for: bwrap can be on PATH
  // and still be unable to create a user namespace. Only running it says so.
  assert.deepEqual(calls, [
    { exe: '/usr/bin/bwrap', args: ['--unshare-all', '--ro-bind', '/', '/', 'true'] },
  ]);
});

test('an AppArmor-blocked user namespace gets the AppArmor fix, not "install it"', () => {
  const { host } = fakeProbe({
    which: { bwrap: '/usr/bin/bwrap' },
    result: { code: 1, stderr: 'bwrap: Creating new namespace failed: Operation not permitted\n' },
  });

  const verdict = only(probeBackends('linux', host));

  assert.equal(verdict.usable, false);
  assert.equal(verdict.reason, 'userns-blocked');
  // The raw error, first line only: the user recognises their own machine in it.
  assert.match(verdict.detail, /^bwrap: Creating new namespace failed/);
  assert.match(verdict.fix ?? '', /apparmor_parser/);
  assert.doesNotMatch(verdict.fix ?? '', /apt-get install bubblewrap/);
});

test('a WSL user is probed with bubblewrap, not told to use WSL', () => {
  const { host } = fakeProbe({});

  // Bubblewrap runs inside the distro, so the fix for a WSL user is the same Linux fix —
  // telling them to "run it in WSL2" from inside WSL would be nonsense.
  assert.deepEqual(
    probeBackends('wsl', host).map((v) => v.name),
    ['bwrap'],
  );
});

test('macOS probes Seatbelt with a permissive profile that still has to apply', () => {
  const { host, calls } = fakeProbe({ which: { 'sandbox-exec': '/usr/bin/sandbox-exec' } });

  const verdict = only(probeBackends('macos', host));

  assert.equal(verdict.name, 'seatbelt');
  assert.equal(verdict.usable, true);
  // The question is "can a profile be applied at all", not "is this policy right".
  assert.deepEqual(calls, [
    {
      exe: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1) (allow default)', '/usr/bin/true'],
    },
  ]);
});

test('a Seatbelt that refuses the profile is an error, with the real message', () => {
  const { host } = fakeProbe({
    which: { 'sandbox-exec': '/usr/bin/sandbox-exec' },
    result: { code: 1, stderr: 'sandbox-exec: cannot apply sandbox profile\n' },
  });

  const verdict = only(probeBackends('macos', host));

  assert.equal(verdict.usable, false);
  assert.equal(verdict.reason, 'error');
  assert.equal(verdict.detail, 'sandbox-exec: cannot apply sandbox profile');
  // Nothing to paste: Apple's deprecation notice is not the user's problem to fix.
  assert.equal(verdict.fix, null);
});

test('Windows is told what to do instead, never left with "unavailable"', () => {
  const verdict = only(probeBackends('windows', fakeProbe({}).host));

  assert.equal(verdict.name, 'none');
  assert.equal(verdict.usable, false);
  assert.equal(verdict.reason, 'unsupported-platform');
  // The honest alternatives: WSL2 works, or keep the tier that does not claim isolation.
  for (const alternative of WINDOWS_ALTERNATIVES) {
    assert.match(verdict.fix ?? '', new RegExp(alternative.split(' ')[0] ?? ''));
  }
});

test('an unknown platform gets no fix, because there is nothing to paste', () => {
  const verdict = only(probeBackends('other', fakeProbe({}).host));

  assert.equal(verdict.name, 'none');
  assert.equal(verdict.fix, null);
});

test('the backend a run should use is the first usable one', () => {
  const missing = { name: 'bwrap', usable: false, reason: 'missing', detail: '', fix: null } as const;
  const ok = { name: 'bwrap', usable: true, reason: 'ok', detail: '/usr/bin/bwrap', fix: null } as const;

  assert.equal(usableBackend([missing, ok]), ok);
  assert.equal(usableBackend([missing]), null);
  assert.equal(usableBackend([]), null);
});