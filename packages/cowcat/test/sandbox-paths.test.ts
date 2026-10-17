import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFs } from '../src/index.js';
import { fakeFs } from './fakes-ports.js';
import {
  DEFAULT_HOME_READ_ALLOW,
  DEFAULT_READ_DENY,
  DEFAULT_WRITE_DENY,
  expand,
  isAbsolutePath,
  resolveEntries,
  type ResolveResult,
} from '../src/index.js';

// Path resolution: what a policy entry MEANS.
//
// Two rules carry the weight here. Every path leaves canonical, because Seatbelt matches
// `(subpath …)` against the path the KERNEL reports — `/var/...` on macOS grants nothing
// for `/private/var/...`, which would make the sandbox refuse to write the project
// itself. And a glob is collected, never dropped: a policy that appears to deny
// `**/*.env` while doing nothing is worse than no policy at all.

const HOME = '/home/u';
const CWD = '/home/u/proj';

function resolve(entries: readonly string[], fs = fakeFs()): ResolveResult {
  return resolveEntries({ entries, cwd: CWD, home: HOME, fs });
}

test('tilde expands against the caller\'s home, not the process\'s', () => {
  // Injected, so this is testable from any machine and does not read process.env.
  assert.equal(expand('~', HOME, CWD), HOME);
  assert.equal(expand('~/.ssh', HOME, CWD), '/home/u/.ssh');
  assert.equal(expand('~/', HOME, CWD), HOME);
  assert.equal(expand('~/.config/gh/hosts.yml', HOME, CWD), '/home/u/.config/gh/hosts.yml');
});

test('another user\'s home is reported, not quietly made relative', () => {
  const result = resolve(['~root/x']);

  // Falling through to the relative branch would produce `<cwd>/~root/x`: a path that
  // reads like a home reference and silently is not one.
  assert.deepEqual(result.resolved, []);
  assert.equal(result.unsupported.length, 1);
  const [first] = result.unsupported;
  assert.ok(first !== undefined);
  assert.match(first.why, /not expanded/);
});

test('relative entries resolve against the session cwd', () => {
  assert.equal(expand('.env', HOME, CWD), '/home/u/proj/.env');
  assert.equal(expand('.git/hooks', HOME, CWD), '/home/u/proj/.git/hooks');
  assert.equal(expand('sub/dir', HOME, CWD), '/home/u/proj/sub/dir');
});

test('absolute entries are left alone, on either platform\'s spelling', () => {
  // isAbsolute is implemented here rather than delegated to node:path, because a policy
  // written on Windows must resolve identically when the test runs on Linux.
  assert.equal(expand('/usr/lib', HOME, CWD), '/usr/lib');
  assert.equal(expand('C:\\Users\\u\\proj', HOME, CWD), 'C:\\Users\\u\\proj');
  assert.equal(isAbsolutePath('/x'), true);
  assert.equal(isAbsolutePath('C:/x'), true);
  assert.equal(isAbsolutePath('\\\\server\\share'), true);
  assert.equal(isAbsolutePath('relative/x'), false);
});

test('a glob is collected with a reason, not silently dropped', () => {
  const result = resolve(['/home/u/proj/**/.env', '~/.ssh']);

  // The glob is not in the resolved list, and it is not gone either.
  assert.deepEqual(result.resolved, ['/home/u/.ssh']);
  assert.equal(result.unsupported.length, 1);
  const [first] = result.unsupported;
  assert.ok(first !== undefined);
  assert.equal(first.entry, '/home/u/proj/**/.env');
  assert.match(first.why, /glob/);
});

test('results are canonical, so the backend receives kernel paths', () => {
  const fs = new NodeFs();
  const result = resolve(['/home/u/proj'], fs);
  const [first] = result.resolved;

  // Symlink resolution happens HERE rather than in the backend: on macOS /var is a
  // symlink to /private/var, and Seatbelt matches against the kernel's spelling, so a
  // profile written with the friendly one grants nothing (ADR-017).
  assert.equal(result.resolved.length, 1);
  assert.equal(first, fs.canonical('/home/u/proj'));
});

test('duplicates collapse, keeping the order the entries were given', () => {
  const result = resolve(['/a', '/b', '/a', '/c', '/b']);

  assert.deepEqual(result.resolved, ['/a', '/b', '/c']);
});

test('blank entries are ignored rather than becoming the cwd', () => {
  // An empty entry resolving to the cwd would silently grant the whole project — the
  // kind of thing that reads as a deliberate allowance in a review.
  const result = resolve(['', '   ', '/a']);

  assert.deepEqual(result.resolved, ['/a']);
});

test('the default policy denies the credential paths and grants the toolchain\'s home files', () => {
  // Each entry has a reason, and the reasons are the reason this file exists rather
  // than being configuration:
  assert.deepEqual(DEFAULT_READ_DENY, ['~/.ssh', '~/.config/gh', '~/.git-credentials', '~/.cowcat', '~/.aws', '~/.gnupg']);
  // Without these, `git commit` inside the sandbox has no identity and npm has no
  // cache — and users switch the tier off within a day.
  assert.deepEqual(DEFAULT_HOME_READ_ALLOW, ['~/.gitconfig', '~/.npm', '~/.cache']);
  // `.env` because a sandboxed write to it is how a secret reaches a commit; hooks
  // because a hook is code that runs outside every decision we make.
  assert.deepEqual(DEFAULT_WRITE_DENY, ['.env', '.git/hooks']);
});

test('the default credential paths and home paths both resolve', (t) => {
  // A REAL home directory, because canonicalization is the host's: on Windows a POSIX
  // spelling like `/home/u/.ssh` is rewritten to `F:\home\u\.ssh`, which is correct
  // behaviour for the adapter and a broken assumption for a test.
  const fs = new NodeFs();
  const home = fs.canonical(mkdtempSync(join(tmpdir(), 'cowcat-home-')));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const cwd = join(home, 'proj');
  mkdirSync(cwd);

  const denied = resolveEntries({ entries: DEFAULT_READ_DENY, cwd, home, fs });
  const allowed = resolveEntries({ entries: DEFAULT_HOME_READ_ALLOW, cwd, home, fs });

  assert.deepEqual(denied.unsupported, [], 'no default is a glob');
  assert.equal(denied.resolved.length, DEFAULT_READ_DENY.length);
  assert.equal(allowed.resolved.length, DEFAULT_HOME_READ_ALLOW.length);
  // The `~` was expanded — none of these is still a literal tilde.
  for (const path of [...denied.resolved, ...allowed.resolved]) {
    assert.ok(path.startsWith(home), `${path} is not under ${home}`);
  }
});