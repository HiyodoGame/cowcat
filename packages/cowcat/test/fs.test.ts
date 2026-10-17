import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { NodeFs } from '../src/index.js';

// Path identity, against a real filesystem.
//
// A fake filesystem would be the wrong tool here: the property under test IS the
// filesystem's behaviour (does realpath resolve this symlink, does stat follow it,
// what does it do with a path that does not exist). So these tests build real
// directories and real symlinks, and skip with the reason — never vacuously — when
// the platform refuses to create one.
//
// The origin story is in the header of src/adapters/fs.ts: macOS `/var` vs
// `/private/var` made one directory look like two, and seven tests failed for it.

interface Pair {
  readonly base: string;
  readonly real: string;
  readonly link: string;
  readonly file: string;
}

function symlinkedPair(fs: NodeFs): Pair {
  // Both halves are CANONICAL, deliberately. A fixture built from a raw os.tmpdir()
  // does not match what the product emits whenever the filesystem answers tmpdir()
  // with a different spelling than realpath (macOS /var vs /private/var, the Windows
  // runner's RUNNER~1 vs runneradmin), which would make the assertions below fail for
  // reasons that have nothing to do with the adapter.
  const base = fs.canonical(mkdtempSync(join(tmpdir(), 'cowcat-fs-')));
  const real = fs.canonical(join(base, 'real'));
  mkdirSync(real);
  const file = join(real, 'file.txt');
  writeFileSync(file, 'x');
  const link = join(base, 'link');
  // 'junction' on Windows: it needs no privilege, and it points at a directory, which
  // is the case that matters.
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.clearCache();
  return { base, real, link, file };
}

/**
 * Build the fixture and register its cleanup, or skip the test and return null.
 * `t.skip()` is typed as returning void, so the null is what lets a caller stop
 * instead of asserting on a pair that was never built.
 */
function pairFor(t: TestContext, fs: NodeFs): Pair | null {
  try {
    const pair = symlinkedPair(fs);
    t.after(() => {
      rmSync(pair.base, { recursive: true, force: true });
    });
    return pair;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    t.skip(`this filesystem refuses directory symlinks: ${code ?? String(error)}`);
    return null;
  }
}

/**
 * A symlink with nothing behind it. Separate from `pairFor` because it needs the
 * FILE-symlink privilege, which Windows grants only with Developer Mode — a machine
 * can allow directory junctions and still refuse this one.
 */
function brokenLinkFor(t: TestContext, base: string): string | null {
  const broken = join(base, 'broken');
  try {
    symlinkSync(join(base, 'nothing-here'), broken);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    t.skip(`this filesystem refuses file symlinks: ${code ?? String(error)}`);
    return null;
  }
  t.after(() => {
    rmSync(broken, { force: true });
  });
  return broken;
}

test('a symlinked spelling resolves to the directory it names', (t) => {
  const fs = new NodeFs();
  const p = pairFor(t, fs);
  if (p === null) return;

  assert.notEqual(p.link, p.real, 'the two spellings must differ for this test to mean anything');
  assert.equal(fs.canonical(p.link), p.real);
  assert.equal(fs.canonical(p.real), p.real, 'the real path is already canonical');
  assert.equal(fs.samePath(p.link, p.real), true);
  assert.equal(fs.samePath(p.link, join(p.base, 'nope')), false);
});

test('a path that does not exist yet keeps its canonical prefix', (t) => {
  const fs = new NodeFs();
  const p = pairFor(t, fs);
  if (p === null) return;

  // `.env` in write.allow routinely does not exist yet, and a worktree sibling is
  // created after the policy is built. Resolving the deepest EXISTING ancestor is
  // what keeps those entries pointing at the real place instead of the symlink, which
  // is what makes a Seatbelt `(subpath …)` filter grant the directory it names.
  assert.equal(fs.canonical(join(p.link, 'new', 'file.txt')), join(p.real, 'new', 'file.txt'));
  assert.equal(fs.canonical(join(p.link, '.env')), join(p.real, '.env'));
  // Segments that collapse before the walk starts: link/../real is the base's real
  // directory, not a child of the link.
  assert.equal(fs.canonical(join(p.link, '..', 'real')), p.real);
});

test('a relative path is resolved against the cwd before anything else', () => {
  const fs = new NodeFs();

  // `resolve()` first, so `.` and `..` are collapsed before the walk takes dirname();
  // otherwise the loop chases an ancestor that does not exist.
  assert.equal(fs.canonical('.'), fs.canonical(process.cwd()));
  assert.equal(fs.canonical('does/not/exist/../here'), fs.canonical(resolve('does/not/exist/../here')));
  assert.ok(isAbsolute(fs.canonical('some/relative/path')));
});

test('never throws, whatever it is handed', () => {
  const fs = new NodeFs();

  // The empty path is the trap: resolve('') is the cwd, so without the early return it
  // would answer "the current directory" to a question nobody asked.
  assert.equal(fs.canonical(''), '');
  assert.equal(fs.samePath('', ''), true);
  assert.equal(fs.exists(''), false);
  assert.equal(fs.kindOf(''), null);

  const missing = join(tmpdir(), 'cowcat-definitely', 'not', 'there', 'at', 'all');
  assert.doesNotThrow(() => fs.canonical(missing));
  assert.equal(fs.exists(missing), false);
  assert.equal(fs.kindOf(missing), null);
  // A missing path is still comparable with itself: identity does not require existence.
  assert.equal(fs.samePath(missing, missing), true);
  assert.equal(fs.samePath(missing, join(tmpdir(), 'other')), false);
});

test('kindOf and exists follow symlinks, and agree on a broken one', (t) => {
  const fs = new NodeFs();
  const p = pairFor(t, fs);
  if (p === null) return;
  const broken = brokenLinkFor(t, p.base);
  if (broken === null) return;

  assert.equal(fs.kindOf(p.real), 'directory');
  assert.equal(fs.kindOf(p.file), 'file');
  assert.equal(fs.kindOf(p.link), 'directory', 'a link to a directory IS a directory to a policy');
  assert.equal(fs.exists(p.link), true);
  assert.equal(fs.exists(p.file), true);

  // exists() is false and kindOf() is null rather than an exception, because this is
  // asked while deciding what a command may touch, where a throw becomes a crash.
  fs.clearCache();
  assert.equal(fs.exists(broken), false);
  assert.equal(fs.kindOf(broken), null);
});

test(
  'a path that is neither a file nor a directory is "other"',
  { skip: process.platform === 'win32' ? 'POSIX character devices have no Windows equivalent' : false },
  () => {
    const fs = new NodeFs();

    // The character device is the portable-ish way to reach the third branch; the
    // Windows leg covers the other two, and this one is declared unreachable there.
    assert.equal(fs.kindOf('/dev/null'), 'other');
    assert.equal(fs.exists('/dev/null'), true);
  },
);

test('a memoised answer stays until it is cleared', (t) => {
  const fs = new NodeFs();
  const p = pairFor(t, fs);
  if (p === null) return;

  // Repeated calls are the whole reason the cache exists: canonical() is on the hot
  // path (every Bash call resolves a policy).
  assert.equal(fs.canonical(p.link), fs.canonical(p.link));

  // Retargeting a symlink mid-session is the staleness window, and it is a contract
  // rather than a claim: the memoised answer wins until clearCache() is called. The
  // escape hatch is what lets a caller that moves things underneath us be honest;
  // what is not acceptable is not knowing which answer you are getting.
  rmSync(p.link, { force: true });
  const moved = join(p.base, 'moved');
  mkdirSync(moved);
  symlinkSync(moved, p.link, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(fs.canonical(p.link), p.real, 'still the memoised answer');
  fs.clearCache();
  assert.equal(fs.canonical(p.link), moved, 'clearCache() is the way out');
});

test('each instance memoises on its own', (t) => {
  const p = pairFor(t, new NodeFs());
  if (p === null) return;

  // The legacy implementation kept its cache in a module-level Map, so two adapters
  // shared one and no test could get a clean one. An instance field makes the
  // composition root own the state and makes isolation free.
  const first = new NodeFs();
  const second = new NodeFs();
  assert.equal(first.canonical(p.link), p.real);
  assert.equal(second.canonical(p.link), p.real);
  first.clearCache();
  assert.equal(second.canonical(p.link), p.real, 'clearing one instance does not empty the other');
});