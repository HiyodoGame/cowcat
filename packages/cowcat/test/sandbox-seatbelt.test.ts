import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeatbeltCommand,
  defaultSandboxProfile,
  isUnder,
  RUNTIME_ALLOWS,
  SEATBELT_READ_PATHS,
  type SandboxProfile,
} from '../src/index.js';

// The Seatbelt profile, generated on a machine that is not macOS.
//
// This is the point of keeping the generator pure: the profile is ~150 rules and every
// one of them encodes a Seatbelt semantic that is NOT what you would guess (last match
// wins, a specific deny beats a wildcard allow, the root inode is not covered by a
// subpath allow-list). Reading the emitted profile is the only practical way to check
// those orderings, and doing it on the CI machine would need a macOS runner per change.
//
// What is NOT checked here: that macOS ACCEPTS the profile. That is the
// `packages/cowcat · node 22 · macos-15` leg's job, and it is the real assertion.

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return defaultSandboxProfile({
    mode: 'system',
    read: { profile: 'workspace', allow: ['/Users/u/proj'], deny: ['/Users/u/.ssh'] },
    write: { allow: ['/Users/u/proj'], deny: ['/Users/u/proj/.env'] },
    ...overrides,
  });
}

function build(overrides: Partial<SandboxProfile> = {}, tmpDir: string | null = null) {
  const built = buildSeatbeltCommand(profile(overrides), {
    command: 'echo hi',
    cwd: '/Users/u/proj',
    tmpDir,
  });
  return { ...built, text: built.args[1] ?? '' };
}

function lastIndexOf(text: string, needle: string): number {
  return text.lastIndexOf(needle);
}

test('the profile denies by default and starts from a runtime floor', () => {
  const { text } = build();

  // `(deny default)` first: everything below is an exception, so a rule we forgot to
  // emit fails CLOSED rather than open.
  assert.ok(text.includes('(deny default)'));
  assert.ok(text.indexOf('(deny default)') < text.indexOf('(allow process-exec)'));
  // The floor is what a /bin/bash process needs to start at all. Without it, dyld
  // aborts before exec with no message.
  for (const line of RUNTIME_ALLOWS) {
    assert.ok(text.includes(line.split('\n')[0] ?? ''), `missing runtime rule: ${line}`);
  }
});

test('the command and the profile travel as two argv elements', () => {
  const built = buildSeatbeltCommand(profile(), { command: 'echo hi', cwd: '/Users/u/proj' });

  // `-p` takes the profile as ONE argument; the command after it is exec'd directly,
  // so the model's command never passes through a shell twice.
  assert.equal(built.file, '/usr/bin/sandbox-exec');
  assert.equal(built.args[0], '-p');
  assert.deepEqual(built.args.slice(2), ['/bin/bash', '-c', 'echo hi']);
});

test('read denies come AFTER read allows, because last match wins', () => {
  const { text } = build();

  const allow = text.indexOf('(allow file-read*');
  const deny = text.indexOf('(deny file-read*');
  // Reversed, a `(deny file-read* (subpath ~/.ssh))` would be undone by the allow that
  // follows it and the credential directory would be readable again.
  assert.ok(allow >= 0 && deny > allow, 'the deny must come last among the read rules');
});

test('a specific deny is not undone by a wildcard write allow', () => {
  const { text } = build();
  const moveDeny = text.indexOf('(deny file-write-unlink file-write-create');

  assert.ok(moveDeny >= 0, 'renaming a read-denied path is a read bypass, so it is denied');
  // ...and then unlink/create is re-opened for the write roots, or `rm` inside the
  // project becomes impossible.
  const reopen = lastIndexOf(text, '(allow file-write-unlink file-write-create');
  assert.ok(reopen > moveDeny, 'the write roots re-open it, deliberately and last');
});

test('the root inode is allowed explicitly', () => {
  const { text } = build();

  // Measured on macOS 15: an allow-LIST of subpath filters does not cover `/`, and the
  // missing grant is not an EPERM — dyld aborts before exec with SIGABRT and no
  // message, which reads as an unrelated crash.
  assert.ok(text.includes('(allow file-read* (literal "/"))'));
  // What it costs: `ls /` can list the top-level names. No subtree content.
});

test('directory metadata is allowed after the denies, so realpath still works', () => {
  const { text } = build();
  const metadata = text.indexOf('(allow file-read-metadata (vnode-type DIRECTORY))');
  const deny = text.indexOf('(deny file-read*');

  // Metadata only — no readdir, no contents — but without it every path crossing a
  // denied region fails to resolve. After the denies, so denied directories stay denied.
  assert.ok(metadata > deny);
});

test('the kernel spellings are used, not the friendly ones', () => {
  const { text } = build();

  // `/etc`, `/var` and `/tmp` are symlinks into /private on macOS, and `subpath` matches the
  // path the KERNEL resolves to — so the canonical form is what belongs on the allow side.
  for (const path of SEATBELT_READ_PATHS) {
    assert.ok(text.includes(`(subpath ${JSON.stringify(path)})`), `missing ${path}`);
  }
});

test('metadata is granted for SYMLINK vnodes, or no absolute path a person types works', () => {
  // The rule that actually makes `/var/folders/…` work, which is why it is not optional.
  // Measured on macOS 15, one profile, one file:
  //
  //     read /private/var/folders/…/n.txt   OK
  //     read /var/folders/…/n.txt          EPERM   without this rule
  //     read /var/folders/…/n.txt          OK      with it
  //
  // The walk begins at the path the caller typed, and `/var` is a symlink; resolving it
  // needs read access to a SYMLINK vnode. The DIRECTORY rule beside it does not cover that,
  // and because `subpath` itself is fine the failure looks like a spelling problem rather
  // than a missing rule — which is what sent this file down the wrong fix first (note 8).
  const { text } = build();

  assert.ok(text.includes('(allow file-read-metadata (vnode-type SYMLINK))'), 'the symlink metadata rule');
  // Metadata only, and after the denies: a denied path must keep denying its CONTENTS even
  // though this rule now follows it. file-read-data is what carries contents, and this rule
  // does not name it.
  const denyEnd = text.indexOf('(allow file-read* (literal "/"))');
  assert.ok(text.indexOf('(vnode-type SYMLINK)') > denyEnd, 'it has to come after the read denies');
  assert.equal(text.includes('(allow file-read* (vnode-type SYMLINK))'), false, 'metadata only, not every read op');
});

test('no dual-spelling rules: one path, one filter', () => {
  // A rejected experiment, kept as a test because it is the kind of change that looks
  // obviously right. Emitting every path under BOTH `/private/var/…` and `/var/…` does NOT
  // make friendly spellings work — the symlink rule above is what does, and the same
  // measurement shows a canonical-only profile succeeds once it is present.
  //
  // So the dual spelling bought nothing and cost something real: every deny has to be
  // duplicated by hand in two spellings, and one missed duplicate turns a credential deny
  // into a two-keystroke bypass. A wider deny surface for no gain is worse than none.
  const { text } = build({
    read: { profile: 'workspace', allow: ['/private/var/folders/x/proj'], deny: ['/private/var/folders/x/home/.ssh'] },
  });

  assert.ok(text.includes('(subpath "/private/var/folders/x/home/.ssh")'), 'the canonical deny');
  assert.equal(text.includes('(subpath "/var/folders/x/home/.ssh")'), false, 'and no friendly twin — see the test name');
  assert.equal(text.includes('(subpath "/var/folders/x/proj")'), false, 'nor on the allow side');
});

test('network on is refused, not rendered as a half-working profile', () => {
  const { text, limitations } = build({ network: 'on' });

  // The executor refuses this combination before it gets here; rendering it honestly
  // anyway means a bypass produces a visible `network*` rule rather than silence.
  assert.ok(text.includes('(allow network*)'));
  assert.ok(limitations.some((entry) => entry.includes('name resolution')));
  // ...while the default renders nothing at all and says so in a comment.
  const off = build();
  assert.equal(off.text.includes('(allow network*)'), false);
  assert.ok(off.text.includes('; network denied (policy: off)'));
});

test('a denied path inside a write root is taken back at the very end', () => {
  // The write section re-allows unlink for the write roots, which would hand a
  // read-denied path back its renameability. The tail block exists for exactly this.
  const { text } = build({
    read: { profile: 'workspace', allow: ['/Users/u/proj'], deny: ['/Users/u/proj/.env'] },
    write: { allow: ['/Users/u/proj'], deny: [] },
  });

  const tail = text.slice(lastIndexOf(text, '; Read-denied paths inside write roots stay in place'));
  assert.ok(tail.includes('/Users/u/proj/.env'), 'the path is named again');
  assert.ok(tail.indexOf('(deny file-write-unlink') < tail.indexOf('/Users/u/proj/.env'));
});

test('the private temp directory is writable AND readable, or a build cannot read back', () => {
  const withTmp = build({}, '/private/var/folders/x/T/cowcat-sandbox-1');
  const text = withTmp.text;

  assert.ok(text.includes(`(subpath "/private/var/folders/x/T/cowcat-sandbox-1")`));
  // Writable from the write section, readable from the tail — the second is easy to
  // forget and breaks every tool that writes then reads its own scratch file.
  assert.ok(text.includes('(allow file-read* (subpath "/private/var/folders/x/T/cowcat-sandbox-1"))'));
});

test('the open read profile admits what it costs', () => {
  const { text, limitations } = build({ read: { profile: 'hide', allow: [], deny: ['/Users/u/.ssh'] } });

  assert.ok(text.includes('(allow file-read*)'), 'reads are open outside the denies');
  assert.equal(text.includes('(allow file-read* (literal "/"))'), false, 'not needed when reads are open');
  assert.ok(limitations.some((entry) => entry.includes('hide')));
});

test('isUnder is strictly-inside, not prefix-matching', () => {
  // String prefixes would make /Users/u/proj-old "inside" /Users/u/proj, which silently
  // re-dens the wrong tree.
  assert.equal(isUnder('/a/b/c', '/a/b'), true);
  assert.equal(isUnder('/a/b', '/a/b'), false, 'a path is not inside itself');
  assert.equal(isUnder('/a/bc', '/a/b'), false);
  assert.equal(isUnder('/a/b/c/', '/a/b'), true);
  assert.equal(isUnder('C:\\a\\b', 'C:\\a'), true);
});