import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { NodePlatform, detectPlatformId, type RunResult } from '../src/index.js';

// Port-level checks against the real host. Everything else about the chain is decided in
// shell.test.ts; what a fake cannot tell us is whether the default wiring — `where.exe`,
// `existsSync`, `spawnSync` — actually finds a shell on a machine we did not prepare.
function injected(options: {
  readonly platform: string;
  readonly env?: Record<string, string | undefined>;
  readonly files?: readonly string[];
  readonly working?: readonly string[];
}): { platform: NodePlatform; runs: string[] } {
  const runs: string[] = [];
  const files = new Set(options.files ?? []);
  const working = new Set(options.working ?? []);
  const platform = new NodePlatform({
    platform: options.platform,
    env: options.env ?? {},
    which: () => null,
    exists: (path) => files.has(path),
    run: (exe) => {
      runs.push(exe);
      const result: RunResult = working.has(exe)
        ? { code: 0, stdout: 'COWCAT_SHELL_OK', stderr: '' }
        : { code: 127, stdout: '', stderr: '' };
      return result;
    },
  });
  return { platform, runs };
}

test('the resolved shell and backend probe happen once per session', () => {
  const { platform, runs } = injected({
    platform: 'linux',
    files: ['/bin/bash'],
    working: ['/bin/bash'],
  });

  const first = platform.resolveShell();
  const second = platform.resolveShell();
  platform.sandboxBackends();
  platform.sandboxBackends();

  // PowerShell 5.1 costs ~745ms to start and the backend probe spawns processes, so a
  // per-call probe would show up in every tool call's latency.
  assert.deepEqual(runs, ['/bin/bash']);
  assert.equal(first, second);
  assert.deepEqual(platform.shellAttempts(), [{ executable: '/bin/bash', outcome: 'selected' }]);
});

test('Windows kills a whole tree with taskkill and admits there is no graceful phase', () => {
  const { platform } = injected({ platform: 'win32' });

  // Measured on Windows: SIGTERM is not catchable there, so a graceful-then-forceful
  // sequence is a fiction — `/F` is the only semantics available (ADR-014).
  assert.deepEqual(platform.termination(), { kind: 'taskkill-tree', graceMs: 0, supportsGraceful: false });
});

test('POSIX platforms signal a process group, with a grace period before SIGKILL', () => {
  for (const [platform, env] of [
    ['linux', {}],
    ['darwin', {}],
    ['linux', { WSL_DISTRO_NAME: 'Ubuntu' }],
  ] as const) {
    assert.deepEqual(new NodePlatform({ platform, env }).termination(), {
      kind: 'process-group',
      graceMs: 3_000,
      supportsGraceful: true,
    });
  }
});

test('on a real host the shell is found by absolute path', () => {
  const platform = new NodePlatform();
  const shell = platform.resolveShell();

  // The load-bearing invariant: never a bare name, because on this project's reference
  // machine `bash` on PATH is the WSL launcher and, after it, an OpenSSH shim that runs
  // but is the wrong shell (docs/research/p2-shell-detection.md).
  assert.ok(isAbsolute(shell.executable), shell.executable);
  assert.ok(shell.commandFlag !== '');
  assert.ok(platform.sandboxBackends().length > 0);
});

// This is the assertion that makes the POSIX order a measurement rather than a
// prediction. macOS is where it matters: /bin/bash exists but is 3.2, and the
// platform default is /bin/zsh, so "POSIX prefers /bin/bash" is exactly the claim that
// needs a real host to believe — and macos-15 is the only runner where it is not
// trivially true. Deliberately a hard failure: if macOS ever resolves to something
// else, that is a change in the sandbox-profile assumption, not a flaky environment.
const hostPlatform = detectPlatformId(process.env, process.platform);
const onPosixHost = hostPlatform === 'linux' || hostPlatform === 'macos' || hostPlatform === 'wsl';

test(
  'on a POSIX host the shell is /bin/bash, not the login shell',
  { skip: onPosixHost ? false : `only meaningful on POSIX hosts, not ${hostPlatform}` },
  () => {
    const shell = new NodePlatform().resolveShell();

    // Why bash and not zsh: the Seatbelt and bwrap profiles hardcode /bin/bash, so
    // running bash outside the sandbox and zsh inside it would turn "works here, fails
    // there" into a far harder bug than an outdated bash.
    assert.equal(shell.executable, '/bin/bash');
    assert.equal(shell.kind, 'posix');
    assert.deepEqual(shell.baseArgs, []);
    assert.equal(shell.commandFlag, '-c');
  },
);