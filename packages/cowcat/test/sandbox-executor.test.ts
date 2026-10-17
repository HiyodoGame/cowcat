import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSandboxCommand,
  createSandboxExecutor,
  defaultSandboxProfile,
  shellQuote,
  SandboxRequestRefusedError,
  SandboxUnavailableError,
  type ProcessSpec,
  type SandboxBackendVerdict,
  type SandboxFsProbe,
  type SandboxProfile,
} from '../src/index.js';
import { fakePlatform } from './fakes-ports.js';

// The executor: which backend, and what happens when the answer is "no".
//
// Two refusals that must never turn into a quiet downgrade (ADR-016), and one piece of
// state with a lifetime — the private scratch directory macOS needs — which is easy to
// leak and impossible to notice after the fact.

function verdict(overrides: Partial<SandboxBackendVerdict> = {}): SandboxBackendVerdict {
  return { name: 'bwrap', usable: true, reason: 'ok', detail: '/usr/bin/bwrap', fix: null, hardening: ['disable-userns'], ...overrides };
}

const PROBE: { dirs: readonly string[]; files: readonly string[] } = { dirs: ['/usr', '/bin', '/proj'], files: [] };
const fsProbe: SandboxFsProbe = {
  isDir: (path) => PROBE.dirs.includes(path),
  isFile: (path) => PROBE.files.includes(path),
  canonical: (path) => path,
};

function spec(overrides: Partial<SandboxProfile> = {}, argv: readonly string[] = ['/bin/bash', '-c', 'echo hi']): ProcessSpec {
  return {
    argv,
    cwd: '/proj',
    env: {},
    sandbox: defaultSandboxProfile({
      mode: 'system',
      read: { profile: 'workspace', allow: ['/proj'], deny: [] },
      write: { allow: ['/proj'], deny: [] },
      ...overrides,
    }),
  };
}

test('an explicit backend wins over what the machine reports', () => {
  const built = buildSandboxCommand(spec({ backend: 'seatbelt' }), {
    // Both usable; the configuration asked for one by name, and `auto` would have taken
    // the first. Silently substituting a different backend would run the command under
    // isolation the user did not choose.
    platform: fakePlatform({
      platform: 'macos',
      backends: [verdict({ name: 'bwrap' }), verdict({ name: 'seatbelt' })],
    }),
    fsProbe,
    createScratchDir: () => '/private/tmp/scratch',
    removeScratchDir: () => {},
  });

  assert.equal(built.backend, 'seatbelt');
  assert.equal(built.argv[0], '/usr/bin/sandbox-exec');
});

test('a named backend the platform never probed is refused, not assumed', () => {
  // The probe is the only thing that answers "can this machine do it"; building argv for
  // an unverified backend just moves the failure to spawn time, where it is a confusing
  // ENOENT rather than a refusal with fix instructions.
  assert.throws(
    () => buildSandboxCommand(spec({ backend: 'bwrap' }), { platform: fakePlatform({ backends: [] }), fsProbe }),
    (error: unknown) => {
      if (!(error instanceof SandboxUnavailableError)) return false;
      assert.equal(error.backend, 'bwrap');
      assert.equal(error.reason, 'not-probed');
      return true;
    },
  );
});

test('auto picks the first usable backend the platform reports', () => {
  const built = buildSandboxCommand(spec(), {
    platform: fakePlatform({ backends: [verdict({ name: 'bwrap', hardening: ['disable-userns'] })] }),
    fsProbe,
  });

  assert.equal(built.backend, 'bwrap');
  assert.ok(built.argv.includes('--disable-userns'), 'the probed hardening is passed through');
});

test('auto with no usable backend is refused with the probe\'s own reason and fix', () => {
  const blocked = verdict({ usable: false, reason: 'userns-blocked', detail: 'Operation not permitted', fix: 'sudo install -m 0644 …' });

  assert.throws(
    () => buildSandboxCommand(spec(), { platform: fakePlatform({ backends: [blocked] }), fsProbe }),
    (error: unknown) => {
      if (!(error instanceof SandboxUnavailableError)) return false;
      // Verbatim from the probe: a paraphrase would cost the user the exact command.
      assert.equal(error.reason, 'userns-blocked');
      assert.equal(error.detail, 'Operation not permitted');
      assert.ok(error.alternatives.some((entry) => /WSL2/i.test(entry)));
      return true;
    },
  );
});

test('a named backend that is not usable fails loudly rather than falling back', () => {
  const blocked = verdict({ usable: false, reason: 'userns-blocked', detail: 'Operation not permitted', fix: null });

  // Silently using a different backend would run the command under isolation the user
  // did not ask for, which is as wrong as running it bare.
  assert.throws(
    () => buildSandboxCommand(spec({ backend: 'bwrap' }), { platform: fakePlatform({ backends: [blocked] }), fsProbe }),
    SandboxUnavailableError,
  );
});

test('network: on on seatbelt is refused as an unsatisfiable REQUEST, not an unavailable sandbox', () => {
  // The distinction is the whole reason this is a second error class: the sandbox works
  // fine here, so "sandbox is not available" sends the user after the wrong problem.
  assert.throws(
    () =>
      buildSandboxCommand(spec({ backend: 'seatbelt', network: 'on' }), {
        platform: fakePlatform({ platform: 'macos', backends: [verdict({ name: 'seatbelt' })] }),
        fsProbe,
        createScratchDir: () => '/private/tmp/scratch',
        removeScratchDir: () => {},
      }),
    (error: unknown) => {
      if (!(error instanceof SandboxRequestRefusedError)) return false;
      assert.equal(error.request, 'network: on');
      assert.equal(error.reason, 'network-not-supported');
      // The alternatives must be actionable, and must not include falling back to a
      // tier that drops the isolation while keeping the network.
      assert.ok(error.alternatives.some((entry) => /off|ask/i.test(entry)));
      assert.equal(error.alternatives.some((entry) => /light/i.test(entry) && /keep/i.test(entry)), false);
      return true;
    },
  );
});

test('network: on is fine on a backend that can deliver it', () => {
  const built = buildSandboxCommand(spec({ network: 'on' }), {
    platform: fakePlatform({ backends: [verdict()] }),
    fsProbe,
  });

  assert.equal(built.argv.includes('--unshare-net'), false);
});

test('seatbelt gets a private scratch directory, and it does not outlive the run', () => {
  const created: string[] = [];
  const removed: string[] = [];

  const built = buildSandboxCommand(spec({ backend: 'seatbelt' }), {
    platform: fakePlatform({ platform: 'macos', backends: [verdict({ name: 'seatbelt' })] }),
    fsProbe,
    createScratchDir: () => {
      const path = `/private/tmp/scratch-${String(created.length)}`;
      created.push(path);
      return path;
    },
    removeScratchDir: (path) => {
      removed.push(path);
    },
  });

  assert.deepEqual(created, ['/private/tmp/scratch-0']);
  // macOS has no mount namespaces, so TMPDIR is the only way to express a private
  // /tmp — and every toolchain reads it.
  assert.deepEqual(built.env, { TMPDIR: '/private/tmp/scratch-0' });
  assert.equal(removed.length, 0, 'not yet — the run has not happened');

  built.cleanup?.();

  assert.deepEqual(removed, ['/private/tmp/scratch-0'], 'the directory must not outlive the run');
});

test('bwrap needs no scratch directory, because it mounts one', () => {
  let created = 0;
  const built = buildSandboxCommand(spec(), {
    platform: fakePlatform({ backends: [verdict()] }),
    fsProbe,
    createScratchDir: () => {
      created += 1;
      return '/private/tmp/never';
    },
  });

  assert.equal(created, 0, '--tmpfs gives the sandbox its own; creating a host directory would be waste');
  assert.equal(built.env, undefined);
  assert.equal(built.cleanup, undefined);
});

test('the command reaches the sandbox as one shell-safe line, in the caller\'s order', () => {
  const built = buildSandboxCommand(spec({}, ['/bin/bash', '-c', 'echo hi']), {
    platform: fakePlatform({ backends: [verdict()] }),
    fsProbe,
  });

  const tail = built.argv.slice(built.argv.indexOf('--'));
  // 'echo hi' needs its quotes — an unquoted space would split it into two words.
  assert.deepEqual(tail, ['--', '/bin/bash', '-c', "/bin/bash -c 'echo hi'"]);
});

test('argv is quoted, because the sandbox runs it through a shell', () => {
  // Measured: joining argv with spaces and handing it to `sh -c` re-reads every quote in
  // it. A script containing `"` then dies with a syntax error and NO output — which looks
  // exactly like a sandbox that blocks everything, and cost a macOS CI run.
  const script = 'process.stdout.write("RAN:" + require("fs").readFileSync("f.txt","utf8"))';
  const built = buildSandboxCommand(spec({}, [process.execPath, '-e', script]), {
    platform: fakePlatform({ backends: [verdict()] }),
    fsProbe,
  });

  const command = built.argv[built.argv.length - 1];
  assert.ok(command !== undefined);
  // The script arrives verbatim — nothing in it was left to be re-interpreted. (The
  // executable is quoted too when it contains a space, which is the common case on
  // Windows and on runner tool caches.)
  assert.ok(command.includes(`-e '${script}'`), command);
  assert.equal(command.split(' -e ').length, 2, 'the script must not be split by an unquoted space');
  assert.ok(
    command.startsWith(process.execPath) || command.startsWith(`'${process.execPath}'`),
    `the executable must survive intact: ${command}`,
  );
});

test('shellQuote is POSIX-correct for the awkward cases', () => {
  // Round-trip through a real shell is the property that matters; these are the inputs
  // that break a naive join.
  assert.equal(shellQuote('simple'), 'simple', 'no quoting when none is needed');
  assert.equal(shellQuote(''), "''", 'the empty string must not vanish');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('two words'), "'two words'");
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'", 'no expansion inside single quotes');
  assert.equal(shellQuote('a`b`c'), "'a`b`c'", 'no command substitution');
  assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'", 'no word splitting');
  // A backslash is NOT safe to leave bare: the shell would eat it.
  assert.equal(shellQuote('C:\\Users\\u'), "'C:\\Users\\u'");
  assert.equal(shellQuote('/usr/bin/node'), '/usr/bin/node', 'a plain POSIX path stays readable');
});

test('a run with nothing to wrap is refused rather than sandboxed around nothing', () => {
  assert.throws(
    () => buildSandboxCommand(spec({}, []), { platform: fakePlatform({ backends: [verdict()] }), fsProbe }),
    /needs a command to wrap/,
  );
});

test('limitations from the profile and the backend are both reported', () => {
  const built = buildSandboxCommand(spec({ limitations: ['profile-level note'], write: { allow: ['/proj', '/proj/missing'], deny: [] } }), {
    platform: fakePlatform({ backends: [verdict()] }),
    fsProbe,
  });

  // The profile's own notes and the backend's discoveries travel together, so a caller
  // showing "what this sandbox cannot do" does not have to stitch two sources.
  assert.ok(built.limitations.includes('profile-level note'));
  assert.ok(built.limitations.some((entry) => entry.includes('/proj/missing')));
});

test('createSandboxExecutor produces a resolver for the gateway', () => {
  const resolve = createSandboxExecutor({ platform: fakePlatform({ backends: [verdict()] }), fsProbe });

  const built = resolve(spec());

  assert.equal(built.argv[0], 'bwrap');
  assert.equal(built.backend, 'bwrap');
});