import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBwrapCommand,
  BWRAP_READ_PATHS,
  defaultSandboxProfile,
  SANDBOX_TMPFS_BYTES,
  type SandboxFsProbe,
  type SandboxProfile,
} from '../src/index.js';

// The bwrap argv mapping, on a machine that has no /usr.
//
// Injected filesystem rather than the real one: on Windows `/usr` does not exist, so a
// builder that consulted the host would bind nothing and the assertions below would
// pass while proving nothing. Every case here is a rule a reader can check by reading
// the flags, which is the whole reason this layer is a pure function.

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return defaultSandboxProfile({
    mode: 'system',
    read: { profile: 'workspace', allow: ['/proj'], deny: ['/home/u/.ssh'] },
    write: { allow: ['/proj'], deny: ['/proj/.env'] },
    ...overrides,
  });
}

function probe(world: { dirs?: readonly string[]; files?: readonly string[] } = {}): SandboxFsProbe {
  const dirs = new Set(world.dirs ?? []);
  const files = new Set(world.files ?? []);
  return { isDir: (path) => dirs.has(path), isFile: (path) => files.has(path) };
}

const LINUX = probe({ dirs: [...BWRAP_READ_PATHS, '/proj', '/home/u/.ssh'], files: ['/proj/.env'] });

function build(overrides: Partial<SandboxProfile> = {}, options: Record<string, unknown> = {}) {
  return buildBwrapCommand(profile(overrides), {
    command: 'echo hi',
    cwd: '/proj',
    fs: LINUX,
    hardening: ['disable-userns'],
    ...options,
  });
}

test('the command is handed to the shell, argv-style, with no host shell in between', () => {
  const built = build();

  assert.equal(built.file, 'bwrap');
  // `--` then the sandbox's own shell: the model's command never passes through a
  // second shell, and the gateway owns the quoting decision (one place, not two).
  const tail = built.args.slice(built.args.indexOf('--'));
  assert.deepEqual(tail, ['--', '/bin/bash', '-c', 'echo hi']);
});

test('namespace isolation is unconditional except for the network', () => {
  const base = build().args;
  for (const flag of ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts']) {
    assert.ok(base.includes(flag), `${flag} is missing`);
  }
  assert.ok(base.includes('--unshare-net'), 'network off is the default');

  // Network on is the only one that changes, and it changes by being ABSENT — the
  // control is the namespace, never a proxy variable (a client that ignores
  // HTTP_PROXY must still be unable to connect).
  assert.equal(build({ network: 'on' }).args.includes('--unshare-net'), false);
  assert.equal(build({ network: 'ask' }).args.includes('--unshare-net'), true, 'ask is off until granted');
});

test('the workspace profile binds only what it is allowed to', () => {
  const built = build();
  const args = built.args;

  // The project's own path is bound read-write, the read surface read-only.
  assert.ok(args.includes('--bind'), 'the write root must be bound');
  assert.ok(args.includes('/proj'));
  for (const path of ['/usr', '/bin', '/etc']) {
    const index = args.indexOf('--ro-bind');
    assert.ok(index >= 0);
    assert.ok(args.includes(path), `${path} should be bound for a toolchain`);
  }
  // Not bound means not merely unreadable but ABSENT, so a denied read reports ENOENT
  // instead of a permission error that reads as "the file is there but I may not".
  assert.equal(args.includes('/home/u/.other'), false);
});

test('a read-denied directory is covered so it cannot be read through a bind', () => {
  // In the workspace profile the deny is satisfied by not binding the path at all; the
  // tmpfs is what the `hide` profile needs, where everything else IS bound.
  const withHide = build({ read: { profile: 'hide', allow: ['/proj'], deny: ['/home/u/.ssh'] } });
  assert.deepEqual(withHide.args.slice(0, 1), ['--die-with-parent']);
  assert.ok(withHide.args.includes('/home/u/.ssh'), 'the denied path is named');
  assert.ok(withHide.args.includes('--tmpfs'), 'so an empty tmpfs can cover it');

  // In both profiles the denied path is never readable: the closed profile does not bind
  // it, and the open profile covers it with an empty tmpfs. Either way a denied read
  // reports a MISSING file rather than a permission error, which is the outcome that
  // does not invite a model to look for a way around it.
  const closed = build().args;
  const bound = closed.indexOf('--ro-bind', closed.indexOf('/home/u/.ssh') - 2);
  assert.notEqual(closed[closed.indexOf('/home/u/.ssh') - 1], '--ro-bind', 'never bound readable');
  assert.ok(closed[closed.indexOf('/home/u/.ssh') - 1] === '--tmpfs' || bound < 0, 'covered or absent');
});

test('write rules are allow-only, and a denied write is rebound read-only', () => {
  const args = build().args;
  const denyIndex = args.indexOf('/proj/.env');
  assert.ok(denyIndex > 0);
  // Rebinding read-only preserves the contents. Hiding a write-denied FILE would
  // replace it with /dev/null, which is not what a write rule means.
  assert.equal(args[denyIndex - 1], '--ro-bind');
});

test('a write entry naming a path that does not exist is skipped AND reported', () => {
  // Measured: binding a non-existent source fails the WHOLE command ("Can't find
  // source path"), so it cannot simply be bound. Skipping it means the sandbox can
  // never create that path — which must be said out loud rather than swallowed
  // (research/p2-sandbox.md §4.5).
  const built = build(
    { write: { allow: ['/proj', '/proj/dist'], deny: [] } },
    { fs: probe({ dirs: [...BWRAP_READ_PATHS, '/proj'], files: [] }) },
  );

  assert.equal(built.args.includes('/proj/dist'), false, 'the missing path is not bound');
  assert.ok(
    built.limitations.some((entry) => entry.includes('/proj/dist') && entry.includes('does not exist')),
    `expected a limitation naming it, got: ${JSON.stringify(built.limitations)}`,
  );
});

/** The scratch tmpfs, not one of the `--tmpfs` covers a read-denied directory emits. */
function scratchIndex(args: readonly string[]): number {
  const found = args.findIndex((entry, index) => entry === '--tmpfs' && args[index + 1] === '/tmp');
  assert.ok(found >= 0, `no scratch tmpfs in: ${args.join(' ')}`);
  return found;
}

test('the private tmpfs comes FIRST in the workspace profile', () => {
  // Mounts apply in command-line order and later ones win, so a `--tmpfs /tmp` emitted
  // after the read binds SHADOWS every read allowance under the host's /tmp. Measured:
  // with the tmpfs last, an allowed `$HOME/notes.txt` inside a /tmp project is GONE — a
  // policy that appears to grant something and does nothing.
  const args = build().args;
  const scratch = scratchIndex(args);
  const projectBind = args.indexOf('/proj');

  assert.ok(scratch < projectBind, `the scratch filesystem must be mounted before the read binds, got: ${args.join(' ')}`);
});

test('the hide profile mounts it LAST, because the root bind would undo it', () => {
  // The opposite requirement, same reason: `--ro-bind / /` binds the host's /tmp too, so
  // a tmpfs emitted before it would be shadowed and the sandbox would inherit the host's
  // temp directory — the exact half-truth the legacy suite caught in CI on its first run.
  const args = build({ read: { profile: 'hide', allow: ['/proj'], deny: ['/home/u/.ssh'] } }).args;
  const rootBind = args.indexOf('--ro-bind');

  assert.ok(rootBind >= 0 && scratchIndex(args) > rootBind, args.join(' '));
});

test('the scratch directory is private, capped, and shaped like a real /tmp', () => {
  const args = build().args;
  const scratch = scratchIndex(args);
  const perms = args.indexOf('--perms');

  assert.ok(perms >= 0, 'perms are set');
  assert.equal(args[perms + 1], '1777', 'the default tmpfs is 0755 and half of RAM; a real /tmp is 1777');
  const size = args.indexOf('--size');
  assert.equal(args[size + 1], String(SANDBOX_TMPFS_BYTES));
  // Verified that this is enforced, not merely recorded: with a cap, a write past it is
  // cut off and `df` reports the filesystem full.
  assert.ok(perms < scratch && size < scratch, 'perms and size must apply to the scratch mount');
});

test('the read profile choice changes the shape, and says so when it is open', () => {
  const closed = build();
  const open = build({ read: { profile: 'hide', allow: ['/proj'], deny: ['/home/u/.ssh'] } });

  assert.ok(closed.args.includes('--ro-bind'), 'the closed profile builds its own surface');
  assert.ok(open.limitations.some((entry) => entry.includes('hide')), 'the open profile admits what it costs');
});

test('the hardening flags are ordered so the assertion can fail loudly', () => {
  const built = build();
  const user = built.args.indexOf('--unshare-user');
  const disable = built.args.indexOf('--disable-userns');
  const assertOk = built.args.indexOf('--assert-userns-disabled');

  // --assert-userns-disabled turns "the flag was accepted" into "the flag worked", and
  // it only means anything once --disable-userns has run.
  assert.ok(user >= 0, 'a user namespace is required for the restriction to exist');
  assert.ok(disable > user);
  assert.ok(assertOk > disable);
  assert.equal(built.limitations.some((entry) => entry.includes('nested user namespaces')), false);
});

test('without the hardening the builder omits the flags and admits the weaker sandbox', () => {
  const built = build({}, { hardening: [] });

  assert.equal(built.args.includes('--disable-userns'), false);
  assert.ok(built.limitations.some((entry) => entry.includes('nested user namespaces')));
});