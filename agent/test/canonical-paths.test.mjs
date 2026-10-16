// Path identity: one directory, one name.
//
// The macOS CI leg (test/sandbox-macos.test.mjs's sibling, added 2026-10-16)
// found seven test failures with a single root cause: on Darwin `/var` is a
// symlink to `/private/var`, `os.tmpdir()` returns the symlinked spelling and
// `process.cwd()` returns the physical one, and trust/session/policy keys
// compared those two with `===`. A project trusted under one spelling was
// "untrusted" under the other — which silently downgraded the session to plan
// mode. The same mismatch would have made Seatbelt's `(subpath …)` filters fail
// to grant the very directory they name.
//
// These tests build a real symlink so the property is exercised rather than
// assumed. On a filesystem that refuses to create one (Windows without the
// privilege — junctions avoid it for directories, so this normally runs) the
// property tests skip with the reason instead of passing vacuously.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, samePath, _clearPathCache } from '../src/canonical.js';
import { isTrustedProject, trustProject } from '../src/trust.js';
import { cwdSlug } from '../src/session.js';
import { expandPath } from '../src/sandbox/policy.js';

// A real directory plus a symlink to it: the macOS `/var` → `/private/var` shape,
// reproducible on every platform that can create one.
//
// Both halves are CANONICAL. This test file exists because a fixture built from a
// raw os.tmpdir() does not match what the product emits whenever the filesystem
// answers tmpdir() with a different spelling than realpath — macOS /var vs
// /private/var, or the Windows runner's 8.3 RUNNER~1 vs runneradmin. Building
// fixtures canonically is what lets the assertions below stay strict.
function symlinkedPair() {
  const base = canonicalPath(mkdtempSync(join(tmpdir(), 'cowcat-canon-')));
  const real = canonicalPath(join(base, 'real'));
  mkdirSync(real);
  writeFileSync(join(real, 'file.txt'), 'x');
  const link = join(base, 'link');
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  _clearPathCache();
  return { base, real, link };
}

function tryPair() {
  try {
    return { ...symlinkedPair(), skip: false };
  } catch (e) {
    return { skip: `this filesystem refuses directory symlinks: ${e.code || e.message}` };
  }
}

test('canonicalPath: a symlinked spelling resolves to the directory it names', (t) => {
  const p = tryPair();
  if (p.skip) return t.skip(p.skip);
  try {
    assert.notEqual(p.link, p.real, 'the two spellings must differ for this test to mean anything');
    assert.equal(canonicalPath(p.link), p.real);
    assert.equal(canonicalPath(p.real), p.real, 'the real path is already canonical');
    assert.equal(samePath(p.link, p.real), true);
    assert.equal(samePath(p.link, join(p.base, 'nope')), false);
  } finally {
    rmSync(p.base, { recursive: true, force: true });
  }
});

test('canonicalPath: a path that does not exist yet keeps its canonical prefix', (t) => {
  const p = tryPair();
  if (p.skip) return t.skip(p.skip);
  try {
    // `.env` in write.allow routinely does not exist yet, and a worktree
    // sibling is created after the policy is built. Resolving the deepest
    // EXISTING ancestor is what keeps those entries pointing at the real place.
    assert.equal(canonicalPath(join(p.link, 'new', 'file.txt')), join(p.real, 'new', 'file.txt'));
    assert.equal(canonicalPath(join(p.link, '.env')), join(p.real, '.env'));
  } finally {
    rmSync(p.base, { recursive: true, force: true });
  }
});

test('canonicalPath: never throws, and a repeated call is answered from the cache', () => {
  assert.equal(canonicalPath(''), '');
  assert.equal(canonicalPath(null), null);
  assert.doesNotThrow(() => canonicalPath(join(tmpdir(), 'definitely', 'not', 'there', 'at', 'all')));
  _clearPathCache();
  const first = canonicalPath(tmpdir());
  const second = canonicalPath(tmpdir());
  assert.equal(first, second);
});

test('trust: a project trusted under one spelling is trusted under the other', (t) => {
  const p = tryPair();
  if (p.skip) return t.skip(p.skip);
  const home = mkdtempSync(join(tmpdir(), 'cowcat-canon-home-'));
  const prev = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = home;
  try {
    const cfg = { trustedProjects: [p.link] };
    assert.equal(isTrustedProject(cfg, p.real), true, 'trusted via the symlink, asked via the real path');
    assert.equal(isTrustedProject(cfg, p.link), true);

    // Persisting the other spelling must not create a second entry for the same
    // directory — that is what made the old state file grow duplicates.
    const next = trustProject({ trustedProjects: [] }, p.real);
    assert.deepEqual(next.trustedProjects, [p.real], 'stored canonical');
    const again = trustProject({ trustedProjects: [p.link] }, p.real);
    assert.equal(again.trustedProjects.length, 1, 'no duplicate for the same directory');
    assert.equal(isTrustedProject({ trustedProjects: again.trustedProjects }, p.link), true);
    // And it really landed in the state file we pointed it at.
    const onDisk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.trustedProjects, [p.real]);
  } finally {
    if (prev === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = prev;
    rmSync(p.base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('sessions: both spellings resolve to ONE slug, so --resume finds the session', (t) => {
  const p = tryPair();
  if (p.skip) return t.skip(p.skip);
  try {
    assert.equal(cwdSlug(canonicalPath(p.link)), cwdSlug(canonicalPath(p.real)));
  } finally {
    rmSync(p.base, { recursive: true, force: true });
  }
});

test('sandbox policy: entries leave the policy in the form the kernel reports', (t) => {
  const p = tryPair();
  if (p.skip) return t.skip(p.skip);
  try {
    // Seatbelt matches `(subpath …)` against the kernel's path. A write.allow
    // entry that kept the symlinked spelling would not grant the directory, and
    // the sandbox would refuse to write the project itself.
    assert.equal(expandPath(p.link, p.base), p.real);
    assert.equal(expandPath(join(p.link, '.env'), p.base), join(p.real, '.env'));
    // Relative entries resolve against the session cwd and come out canonical.
    assert.equal(expandPath('proj/file', p.link), join(p.real, 'proj', 'file'));
  } finally {
    rmSync(p.base, { recursive: true, force: true });
  }
});