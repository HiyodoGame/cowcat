import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeatbeltCommand,
  defaultSandboxProfile,
  isUnder,
  RUNTIME_ALLOWS,
  SEATBELT_READ_PATHS,
  spellings,
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

  // `/etc`, `/var` and `/tmp` are symlinks into /private on macOS, and the canonical form
  // is what the kernel resolves to — so it must be the one on the allow side.
  for (const path of SEATBELT_READ_PATHS) {
    assert.ok(text.includes(`(subpath ${JSON.stringify(path)})`), `missing ${path}`);
  }
});

test('a granted path is granted under BOTH spellings', () => {
  // Measured on macOS 15, with a profile that already granted the home directory:
  //
  //     read /private/var/folders/…/n.txt   OK
  //     read /var/folders/…/n.txt          EPERM
  //
  // `subpath` matches the literal path the caller passes; the symlink is resolved after
  // the policy check. So one spelling works and the other does not, under the same
  // profile — which makes `/tmp/x` fail while `/private/tmp/x` succeeds, with nothing in
  // the EPERM to say so. A relative path is unaffected, which is why this hides so well:
  // a test suite that uses relative paths passes while a model using absolute ones does
  // not.
  const { text } = build({ read: { profile: 'workspace', allow: ['/private/var/folders/x/proj'], deny: [] } });

  assert.ok(text.includes('(subpath "/private/var/folders/x/proj")'), 'the canonical spelling');
  assert.ok(text.includes('(subpath "/var/folders/x/proj")'), 'and the one a person types');
});

test('a DENIED path is denied under both spellings, or the deny is a bypass', () => {
  // The point of emitting both spellings on the allows is only defensible if the denies
  // do the same. Grant `/private/var/…` while denying only that, and `mv ~/.ssh/id_rsa`
  // by the friendly spelling walks straight through a credential deny.
  const { text } = build({
    read: { profile: 'workspace', allow: ['/private/var/folders/x/proj'], deny: ['/private/var/folders/x/home/.ssh'] },
  });

  const denyBlock = text.slice(text.indexOf('(deny file-read*'), text.indexOf('(allow file-read* (literal "/"))'));
  assert.ok(denyBlock.includes('(subpath "/private/var/folders/x/home/.ssh")'), 'canonical deny');
  assert.ok(denyBlock.includes('(subpath "/var/folders/x/home/.ssh")'), 'friendly deny — without it this is a bypass');

  // Move-blocking covers the same two spellings, for the same reason: `mv` out of a
  // denied path is a read bypass (note 5), and the friendly spelling reaches it too.
  const moveBlock = text.slice(text.indexOf('(deny file-write-unlink'));
  assert.ok(moveBlock.includes('(literal "/var/folders/x/home")'), 'the friendly ancestor');
  assert.ok(moveBlock.includes('(literal "/private/var/folders/x/home")'), 'the canonical ancestor');
});

test('spellings() is a no-op off macOS, so Linux profiles do not change', () => {
  // Not tidiness: a rule that only fires on one platform is a rule nobody can reason about
  // from a Linux log. Everything under /private is macOS, so elsewhere this returns the
  // input unchanged and the emitted profile is byte-identical to before.
  assert.deepEqual(spellings('/Users/u/proj'), ['/Users/u/proj']);
  assert.deepEqual(spellings('/etc'), ['/etc']);
  assert.deepEqual(spellings('C:\\Users\\u'), ['C:\\Users\\u']);
  assert.deepEqual(spellings('/private/var/folders/x'), ['/private/var/folders/x', '/var/folders/x']);
  // The root is not under /private, and /private itself has no twin worth granting.
  assert.deepEqual(spellings('/private'), ['/private']);
  assert.deepEqual(spellings('/'), ['/']);
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
  // forget and breaks every tool that writes then reads its own scratch file. Both
  // spellings, because a tool that hardcodes /tmp must land in the same place.
  assert.ok(
    text.includes('(allow file-read* (subpath "/private/var/folders/x/T/cowcat-sandbox-1")\n  (subpath "/var/folders/x/T/cowcat-sandbox-1"))'),
    'the scratch read allow covers both spellings',
  );
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