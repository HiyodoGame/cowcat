import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBwrapCommand,
  defaultSandboxProfile,
  probeBackends,
  usableBackend,
  WINDOWS_ALTERNATIVES,
  type ProbeHost,
  type SandboxBackendVerdict,
  type SandboxFsProbe,
  type SandboxProfile,
} from '../src/index.js';

// The verdict is the product contract here: "not installed", "user namespaces blocked by
// AppArmor" and "the kernel is too old" need three different fixes, so a verdict carries
// `reason`, the error's first line and a copy-pasteable command. These tests assert the
// classification, and that the probe really runs the backend rather than asking its
// version.
function fakeProbe(options: {
  readonly which?: Record<string, string>;
  readonly result?: { code: number; stdout?: string; stderr?: string };
  /** Per-invocation answer, for the two-pass probe. */
  readonly perCall?: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string };
}): { host: ProbeHost; calls: { exe: string; args: readonly string[] }[] } {
  const calls: { exe: string; args: readonly string[] }[] = [];
  return {
    calls,
    host: {
      which: (name) => options.which?.[name] ?? null,
      run: (exe, args) => {
        calls.push({ exe, args });
        const result = options.perCall?.(args) ?? options.result;
        return { code: result?.code ?? 0, stdout: '', stderr: result?.stderr ?? '' };
      },
    },
  };
}

export function systemProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return defaultSandboxProfile({ mode: 'system', ...overrides });
}

export function fakeFsProbe(world: {
  readonly dirs?: readonly string[];
  readonly files?: readonly string[];
}): SandboxFsProbe {
  const dirs = new Set(world.dirs ?? []);
  const files = new Set(world.files ?? []);
  return { isDir: (path) => dirs.has(path), isFile: (path) => files.has(path) };
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
  //
  // Two runs, in this order: the plain one decides USABILITY, the hardened one decides
  // whether the extra restriction is available (research/p2-sandbox.md §4.1).
  assert.deepEqual(calls, [
    { exe: '/usr/bin/bwrap', args: ['--unshare-all', '--ro-bind', '/', '/', 'true'] },
    {
      exe: '/usr/bin/bwrap',
      args: ['--unshare-user', '--disable-userns', '--assert-userns-disabled', '--unshare-all', '--ro-bind', '/', '/', 'true'],
    },
  ]);
  assert.deepEqual(verdict.hardening, ['disable-userns']);
});

test('a kernel that refuses the hardening still gives a usable, weaker sandbox', () => {
  // The distinction the two-pass probe exists for. Reporting this as unusable would push
  // the user towards switching the sandbox OFF, which is strictly worse than sandboxing
  // without one flag.
  const { host, calls } = fakeProbe({
    which: { bwrap: '/usr/bin/bwrap' },
    perCall: (args) => (args.includes('--disable-userns') ? { code: 1, stderr: 'bwrap: Operation not permitted' } : { code: 0 }),
  });

  const verdict = only(probeBackends('linux', host));

  assert.equal(verdict.usable, true, 'the sandbox itself works');
  assert.deepEqual(verdict.hardening, [], 'but the extra restriction is unavailable');
  assert.match(verdict.detail, /without: disable-userns/, 'and the verdict says so');
  assert.equal(calls.length, 2);
});

test('a sandbox with no hardening emits no user-namespace flags at all', () => {
  // The builder's side of the same contract: emitting the flags unprobed would make the
  // first real command fail on a kernel that does not accept them.
  const profile = systemProfile();
  const built = buildBwrapCommand(profile, {
    command: 'true',
    cwd: '/proj',
    fs: fakeFsProbe({ dirs: ['/usr', '/bin', '/proj'], files: [] }),
    hardening: [],
  });

  assert.equal(built.args.includes('--disable-userns'), false);
  assert.equal(built.args.includes('--unshare-user'), false);
  // ...and says the sandbox is weaker, so the caller can tell the user.
  assert.ok(built.limitations.some((entry) => entry.includes('nested user namespaces')));
});

test('a probed kernel gets the user-namespace flags', () => {
  const built = buildBwrapCommand(systemProfile(), {
    command: 'true',
    cwd: '/proj',
    fs: fakeFsProbe({ dirs: ['/usr', '/bin', '/proj'], files: [] }),
    hardening: ['disable-userns'],
  });

  // Order matters: --unshare-user before --disable-userns, and the assertion that it
  // took effect before the command runs.
  const user = built.args.indexOf('--unshare-user');
  const disable = built.args.indexOf('--disable-userns');
  const verify = built.args.indexOf('--assert-userns-disabled');
  assert.ok(user >= 0 && disable > user && verify > disable, built.args.join(' '));
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
  const missing = { name: 'bwrap', usable: false, reason: 'missing', detail: '', fix: null, hardening: [] } as const;
  const ok = { name: 'bwrap', usable: true, reason: 'ok', detail: '/usr/bin/bwrap', fix: null, hardening: ['disable-userns'] } as const;

  assert.equal(usableBackend([missing, ok]), ok);
  assert.equal(usableBackend([missing]), null);
  assert.equal(usableBackend([]), null);
});