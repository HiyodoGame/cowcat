// P3 T3b — the trust record's storage (ADR-025 decision 3, ADR-028).
//
// This exercises the real file store against a real temporary directory, because the
// parts worth testing are exactly the ones a fake would paper over: missing file vs
// malformed file, canonicalisation on write, dedupe by identity, and preserving keys
// this build does not know about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FileTrustStore, extractTrusted, isTrusted, nodeFs } from '../src/index.js';

// `nodeFs` is the factory; the real port is what it returns.
const fs = nodeFs();

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-trust-'));
  return { dir, file: join(dir, 'nested', 'trust.json') };
}

// Every case gets its own directory and cleans up, so a failure cannot leak state
// into the next one.
function withStore(fn: (store: FileTrustStore, ctx: { dir: string; file: string }) => Promise<void>): () => Promise<void> {
  return async () => {
    const ctx = tempFile();
    try {
      await fn(new FileTrustStore({ file: ctx.file, fs }), ctx);
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

test('a store that does not exist yet reads as empty, with nothing to report', withStore(async (store) => {
  const snapshot = await store.load();
  assert.deepEqual(snapshot.trusted, []);
  assert.equal(snapshot.problem, null, 'a first run is not a problem');
}));

test('malformed JSON reads as empty AND reports the problem', withStore(async (store, ctx) => {
  mkdirSync(join(ctx.dir, 'nested'), { recursive: true });
  writeFileSync(ctx.file, '{ not json');
  const snapshot = await store.load();
  assert.deepEqual(snapshot.trusted, [], 'empty means untrusted, the safe direction');
  assert.match(snapshot.problem ?? '', /not valid JSON/);
  assert.match(snapshot.problem ?? '', /trust\.json/, 'the message names the file');
}));

test('a document with no usable list reads as empty and reports it', withStore(async (store, ctx) => {
  mkdirSync(join(ctx.dir, 'nested'), { recursive: true });
  for (const body of ['[]', '"x"', '{}', '{"trusted": "nope"}', '{"trusted": [1,2]}']) {
    writeFileSync(ctx.file, body);
    const snapshot = await store.load();
    assert.deepEqual(snapshot.trusted, [], body);
    assert.ok(snapshot.problem !== null, body);
  }
}));

test('a list containing junk is rejected as a whole, not silently trimmed', withStore(async (store, ctx) => {
  mkdirSync(join(ctx.dir, 'nested'), { recursive: true });
  writeFileSync(ctx.file, JSON.stringify({ trusted: ['/a', 7, null, '', '/b'] }));
  const snapshot = await store.load();
  assert.deepEqual(snapshot.trusted, [], 'reading it as "trusted minus a few" would be a quiet lie');
  assert.ok(snapshot.problem !== null, 'so it is reported instead');
}));

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

test('add records a canonical path that load then returns', withStore(async (store, ctx) => {
  const target = join(ctx.dir, 'project');
  mkdirSync(target, { recursive: true });
  await store.add(target);

  const snapshot = await store.load();
  assert.equal(snapshot.trusted.length, 1);
  assert.equal(snapshot.trusted[0], fs.canonical(target));
}));

test('add creates the parent directory', withStore(async (store, ctx) => {
  await store.add(ctx.dir);
  assert.ok(readFileSync(ctx.file, 'utf8').includes('trusted'));
}));

test('adding the same directory twice records it once, even via another spelling', withStore(async (store, ctx) => {
  const target = join(ctx.dir, 'project');
  mkdirSync(target, { recursive: true });
  await store.add(target);
  await store.add(target);
  // A second spelling of the same directory: trailing separator, and a `..` hop.
  await store.add(`${target}${process.platform === 'win32' ? '\\' : '/'}`);
  await store.add(join(target, '..', 'project'));

  const snapshot = await store.load();
  assert.equal(snapshot.trusted.length, 1, 'identity, not spelling');
}));

test('add preserves keys this build does not know about', withStore(async (store, ctx) => {
  mkdirSync(join(ctx.dir, 'nested'), { recursive: true });
  writeFileSync(ctx.file, JSON.stringify({ trusted: ['/already'], futureKey: { a: 1 } }));
  await store.add(join(ctx.dir, 'project'));

  const written = JSON.parse(readFileSync(ctx.file, 'utf8')) as { trusted: readonly string[]; futureKey: unknown };
  assert.deepEqual(written.futureKey, { a: 1 }, 'a newer build put that there; do not clobber it');
  assert.equal(written.trusted.length, 2);
}));

test('add over a malformed file rewrites it with just this entry', withStore(async (store, ctx) => {
  mkdirSync(join(ctx.dir, 'nested'), { recursive: true });
  writeFileSync(ctx.file, '{ broken');
  const target = join(ctx.dir, 'project');
  mkdirSync(target, { recursive: true });
  await store.add(target);

  const snapshot = await store.load();
  assert.equal(snapshot.problem, null, 'a successful write leaves a usable file');
  assert.deepEqual(snapshot.trusted, [fs.canonical(target)]);
}));

// ---------------------------------------------------------------------------
// isTrusted — the decision the record feeds
// ---------------------------------------------------------------------------

test('isTrusted matches the directory itself', () => {
  const trusted = [fs.canonical(tmpdir())];
  assert.equal(isTrusted(trusted, tmpdir(), fs), true);
});

test('isTrusted does NOT extend to a subdirectory', () => {
  // Measured legacy behaviour, not an assumption: probe T4 in
  // docs/research/p3-policy.md. A subdirectory must be trusted on its own.
  const dir = fs.canonical(tmpdir());
  assert.equal(isTrusted([dir], join(dir, 'sub'), fs), false);
});

test('isTrusted does NOT extend to the parent', () => {
  const dir = fs.canonical(tmpdir());
  assert.equal(isTrusted([join(dir, 'sub')], dir, fs), false);
});

test('isTrusted is false for an empty record', () => {
  assert.equal(isTrusted([], tmpdir(), fs), false);
});

test('isTrusted matches across two spellings of one existing directory', () => {
  // The macOS `/var` -> `/private/var` case, reproduced with the spellings this
  // platform offers: a trailing separator, and a `..` hop.
  const dir = fs.canonical(tmpdir());
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(isTrusted([dir], `${tmpdir()}${sep}`, fs), true, 'a trailing separator is the same directory');
  assert.equal(isTrusted([dir], join(tmpdir(), '..', basename(tmpdir())), fs), true, 'a `..` hop is the same directory');
});

test('isTrusted does NOT match a sibling that shares a string prefix', () => {
  const dir = fs.canonical(tmpdir());
  assert.equal(isTrusted([dir], `${dir}-elsewhere`, fs), false, 'samePath compares identity, never prefixes');
});

test('isTrusted does NOT match a path that does not exist', () => {
  // canonical() reports the case the FILESYSTEM reports, so it can only correct a
  // spelling whose directory really exists — the deepest-existing-ancestor fallback
  // re-attaches the tail verbatim (ADR-017). A mistyped path therefore stays a
  // distinct identity, which is the right outcome: trusting a typo must not silently
  // trust the real directory. Measured: `.../Local/tmp` does not match `.../Local/Temp`.
  const dir = fs.canonical(tmpdir());
  assert.equal(isTrusted([dir], join(tmpdir(), '..', 'cowcat-no-such-dir-xyz'), fs), false);
});

// ---------------------------------------------------------------------------
// the reader and the writer must agree on the shape
// ---------------------------------------------------------------------------

test('extractTrusted accepts what the writer writes and rejects the rest', () => {
  assert.deepEqual(extractTrusted({ trusted: ['/a'] }), ['/a']);
  assert.deepEqual(extractTrusted({ trusted: [] }), []);
  for (const bad of [null, 7, 'x', [], { trusted: 'x' }, { trusted: [1] }, { other: [] }]) {
    assert.equal(extractTrusted(bad), null, JSON.stringify(bad));
  }
});
