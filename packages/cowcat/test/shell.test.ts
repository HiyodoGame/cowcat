import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlatformId,
  discoverWindowsRoots,
  gitRoots,
  posixPath,
  posixShellCandidates,
  resolveShell,
  windowsShellCandidates,
  winPath,
  type RunResult,
  type ShellHost,
} from '../src/index.js';

// A host whose every answer is declared up front. The chain, the acceptance rule and
// the failure classes are all decided here, so none of these tests depend on whether the
// machine running them happens to have Git in a particular place — which is the whole
// reason those decisions are in an injectable port.
function fakeHost(options: {
  readonly which?: Record<string, string>;
  readonly files?: readonly string[];
  /** Runs, and the right thing comes out. The default meaning of "installed". */
  readonly working?: readonly string[];
  readonly broken?: readonly string[];
}): { host: ShellHost; runs: string[] } {
  const which = options.which ?? {};
  const files = new Set(options.files ?? []);
  const working = new Set(options.working ?? []);
  const broken = new Set(options.broken ?? []);
  const runs: string[] = [];
  return {
    runs,
    host: {
      which: (name) => which[name] ?? null,
      exists: (path) => files.has(path),
      run: (exe) => {
        runs.push(exe);
        const ok: RunResult = { code: 0, stdout: 'COWCAT_SHELL_OK', stderr: '' };
        if (broken.has(exe)) return { code: 1, stdout: '', stderr: 'it went wrong' };
        return working.has(exe) ? ok : { code: 127, stdout: '', stderr: 'not found' };
      },
    },
  };
}

// ── platform identity ────────────────────────────────────────────────────────────

test('the platform id follows the runtime, and WSL is not Linux', () => {
  assert.equal(detectPlatformId({}, 'win32'), 'windows');
  assert.equal(detectPlatformId({}, 'darwin'), 'macos');
  assert.equal(detectPlatformId({}, 'linux'), 'linux');

  // Bubblewrap works inside WSL, but the fix is a distro-side command, so reporting
  // these as the same platform would hand the user the wrong instructions.
  assert.equal(detectPlatformId({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), 'wsl');
  assert.equal(detectPlatformId({ WSL_INTEROP: '/run/WSL/1' }, 'linux'), 'wsl');
  assert.equal(detectPlatformId({ WSL_DISTRO_NAME: '' }, 'linux'), 'linux');
  assert.equal(detectPlatformId({}, 'freebsd'), 'other');
});

// ── installation discovery ───────────────────────────────────────────────────────

test('an install root is found next to git.exe, and from a nested git too', () => {
  const files = ['E:\\Git\\bin\\bash.exe', 'E:\\Git\\usr\\bin\\bash.exe'];

  // The normal layout: `<root>\cmd\git.exe`, one level down.
  assert.deepEqual(gitRoots(['E:\\Git\\cmd\\git.exe'], (p) => files.includes(p), winPath), ['E:\\Git']);
  // The layout you get when the query runs from inside Git Bash: `<root>\mingw64\bin`.
  assert.deepEqual(gitRoots(['E:\\Git\\mingw64\\bin\\git.exe'], (p) => files.includes(p), winPath), ['E:\\Git']);
  // No bash anywhere in those four levels: nothing is guessed.
  assert.deepEqual(gitRoots(['C:\\tools\\git\\cmd\\git.exe'], () => false, winPath), []);
  // Two git paths, one root: reported once.
  assert.deepEqual(
    gitRoots(['E:\\Git\\cmd\\git.exe', 'E:\\Git\\mingw64\\bin\\git.exe'], (p) => files.includes(p), winPath),
    ['E:\\Git'],
  );
});

// ── candidate chain ──────────────────────────────────────────────────────────────

test('on Windows, Git Bash comes first and cmd last', () => {
  const { host } = fakeHost({
    which: { pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
  });
  const candidates = windowsShellCandidates(host, winPath, ['E:\\Git'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });

  assert.deepEqual(
    candidates.map((c) => c.executable),
    [
      'E:\\Git\\bin\\bash.exe',
      'E:\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ],
  );
  // `bin` before `usr\bin`: both run, but only `bin` gives the mingw64-first PATH.
  const [first] = candidates;
  assert.ok(first !== undefined);
  assert.deepEqual(first.baseArgs, []);
  assert.equal(first.commandFlag, '-c');
});

test('no candidate is ever a bare name', () => {
  const { host } = fakeHost({ which: { bash: '/usr/bin/bash', pwsh: '/usr/bin/pwsh', powershell: '/usr/bin/powershell' } });
  const windows = windowsShellCandidates(host, winPath, ['E:\\Git'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  const posix = posixShellCandidates(host, { SHELL: '/bin/zsh' }, ['/opt/git']);

  // A bare name is the whole bug: on the reference machine `bash` on PATH was the WSL
  // launcher, then an OpenSSH shim that RUNS but is the wrong shell
  // (docs/research/p2-shell-detection.md).
  for (const candidate of [...windows, ...posix]) {
    assert.ok(candidate.executable.includes('\\') || candidate.executable.includes('/'), candidate.executable);
  }
});

test('on POSIX, /bin/bash wins even when $SHELL says zsh', () => {
  // Deliberate and macOS-relevant: the default shell there is zsh, but the sandbox
  // profiles hardcode /bin/bash, and a different interpreter inside and outside the
  // sandbox is a much harder bug than an outdated bash.
  const { host } = fakeHost({ files: ['/bin/bash', '/bin/zsh', '/bin/sh'] });
  const candidates = posixShellCandidates(host, { SHELL: '/bin/zsh' });

  assert.deepEqual(
    candidates.map((c) => c.executable),
    ['/bin/bash', '/bin/zsh', '/bin/sh'],
  );
  // The same path offered twice is one candidate, not two attempts.
  assert.deepEqual(
    posixShellCandidates(host, { SHELL: '/bin/bash' }).map((c) => c.executable),
    ['/bin/bash', '/bin/sh'],
  );
});

// ── acceptance ───────────────────────────────────────────────────────────────────

test('a candidate is selected only after it actually runs', () => {
  const files = ['E:\\Git\\bin\\bash.exe', 'E:\\Git\\usr\\bin\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'];
  const { host, runs } = fakeHost({ files, working: ['E:\\Git\\bin\\bash.exe'] });

  const resolved = resolveShell('windows', host, {
    path: winPath,
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    installRoots: ['E:\\Git'],
  });

  assert.equal(resolved.shell.executable, 'E:\\Git\\bin\\bash.exe');
  // Reported as git-bash rather than posix: an MSYS environment behaves differently, and
  // a session log that hides that is harder to debug than one that admits it.
  assert.equal(resolved.shell.kind, 'git-bash');
  assert.deepEqual(runs, ['E:\\Git\\bin\\bash.exe']);
  assert.deepEqual(resolved.attempts, [{ executable: 'E:\\Git\\bin\\bash.exe', outcome: 'selected' }]);
});

test('a candidate that exists but fails to run is passed over, not trusted', () => {
  const files = ['E:\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'];
  const { host, runs } = fakeHost({
    which: { powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    files,
    // Installed, on PATH, and broken — the state `exists` alone cannot see.
    broken: ['E:\\Git\\bin\\bash.exe'],
    working: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  });

  const resolved = resolveShell('windows', host, {
    path: winPath,
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    installRoots: ['E:\\Git'],
  });

  assert.equal(resolved.shell.kind, 'powershell');
  assert.deepEqual(resolved.shell.baseArgs, ['-NoProfile', '-NonInteractive']);
  assert.deepEqual(resolved.attempts, [
    { executable: 'E:\\Git\\bin\\bash.exe', outcome: 'failed' },
    { executable: 'E:\\Git\\usr\\bin\\bash.exe', outcome: 'absent' },
    { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', outcome: 'selected' },
  ]);
  assert.deepEqual(runs, ['E:\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
});

test('a bare /bin/bash is reported as posix, not git-bash', () => {
  const { host } = fakeHost({ files: ['/bin/bash'], working: ['/bin/bash'] });

  const resolved = resolveShell('linux', host, { path: posixPath, env: {} });

  assert.deepEqual(resolved.shell, { kind: 'posix', executable: '/bin/bash', baseArgs: [], commandFlag: '-c' });
});

test('no shell at all is an error naming every candidate, not a silent fallback', () => {
  const { host } = fakeHost({ which: { powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } });

  // Settling for "something that spawns" here would mean the session header claims a
  // shell the user never chose.
  assert.throws(
    () =>
      resolveShell('windows', host, {
        path: winPath,
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        installRoots: ['E:\\Git'],
      }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.match(error.message, /no usable shell found for windows/);
      assert.match(error.message, /E:\\Git\\bin\\bash\.exe \(absent\)/);
      return true;
    },
  );
});

test('root discovery prefers the installation git.exe actually lives in', () => {
  const { host } = fakeHost({
    which: { git: 'E:\\WorkSoftwares\\Git\\mingw64\\bin\\git.exe' },
    files: ['E:\\WorkSoftwares\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'],
  });

  // The registry and `C:\Program Files\Git` were BOTH absent on the reference machine,
  // and Git lived on E:. Reading them as candidates costs nothing; reading either as
  // authoritative would have picked a shell nobody installed.
  const roots = discoverWindowsRoots(host, winPath, ['C:\\Program Files\\Git']);
  assert.equal(roots[0], 'E:\\WorkSoftwares\\Git');
  assert.deepEqual(roots.slice(1), ['C:\\Program Files\\Git']);
});