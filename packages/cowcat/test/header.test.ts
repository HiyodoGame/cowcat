import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initialState,
  JsonlEventStore,
  reduce,
  SCHEMA_VERSION,
  Session,
  SUPPORTED_SCHEMA_VERSIONS,
  UnsupportedSchemaVersionError,
  type KernelEvent,
} from '../src/index.js';
import { MemoryEventStore, sessionDeps } from './support.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

function headerOf(events: readonly KernelEvent[]): Extract<KernelEvent, { type: 'session.opened' }> {
  const first = events[0];
  if (first === undefined || first.type !== 'session.opened') throw new Error('expected a session header');
  return first;
}

function aHeader(overrides: Partial<Extract<KernelEvent, { type: 'session.opened' }>> = {}): KernelEvent {
  return {
    type: 'session.opened',
    seq: 1,
    ts: 1,
    sessionId: 'sess',
    turnId: null,
    schemaVersion: SCHEMA_VERSION,
    cowcatVersion: '0.0.0-test',
    shell: { kind: 'posix', executable: '/bin/sh' },
    ...overrides,
  };
}

test('create writes the session header as the first event', async () => {
  const store = new MemoryEventStore();
  await Session.create(sessionDeps(store, { cowcatVersion: '9.9.9' }), 'sess_h');

  assert.equal(store.events.length, 1);
  const header = headerOf(store.events);
  assert.equal(header.seq, 1);
  assert.equal(header.turnId, null);
  assert.equal(header.schemaVersion, SCHEMA_VERSION);
  assert.equal(header.cowcatVersion, '9.9.9');
});

test('the header records the shell the commands actually ran through', async () => {
  const store = new MemoryEventStore();
  // Absolute, because a bare name can resolve to a different tool entirely — on the
  // reference machine `bash` on PATH is the WSL launcher (docs/research/p2-shell-detection.md).
  const shell = { kind: 'git-bash', executable: 'E:\\WorkSoftwares\\Git\\bin\\bash.exe' } as const;
  await Session.create(sessionDeps(store, { shell }), 'sess_shell');

  assert.deepEqual(headerOf(store.events).shell, shell);
});

test('the header survives a round trip through disk', async () => {
  const dir = tempDir();
  try {
    const deps = sessionDeps(new JsonlEventStore(dir), {
      cowcatVersion: '9.9.9',
      shell: { kind: 'git-bash', executable: 'E:\\WorkSoftwares\\Git\\bin\\bash.exe' },
    });
    const created = await Session.create(deps, 'sess_round');
    const reopened = await Session.open(deps, 'sess_round');

    // Read back through the zod decoder, not from the object we just wrote: the field
    // is only useful if it survives the format.
    const decoded = headerOf(await deps.store.readAll('sess_round'));
    assert.equal(decoded.cowcatVersion, '9.9.9');
    assert.deepEqual(decoded.shell, { kind: 'git-bash', executable: 'E:\\WorkSoftwares\\Git\\bin\\bash.exe' });
    assert.deepEqual(reopened.state, created.state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creating a session that already exists is refused', async () => {
  const deps = sessionDeps(new MemoryEventStore());
  await Session.create(deps, 'sess_twice');

  await assert.rejects(Session.create(deps, 'sess_twice'), /already exists/);
});

test('opening a session that does not exist is refused', async () => {
  const deps = sessionDeps(new MemoryEventStore());

  await assert.rejects(Session.open(deps, 'nope'), /no such session/);
});

test('a log that does not start with a header is refused', async () => {
  const store = new MemoryEventStore();
  // What a log looks like if something appended to it without creating a session.
  store.events.push({
    type: 'turn.opened',
    seq: 1,
    ts: 1,
    sessionId: 'sess_bare',
    turnId: 'turn_1',
    input: 'hi',
  });

  await assert.rejects(Session.open(sessionDeps(store), 'sess_bare'), /no session header/);
});

test('an unsupported schema version is reported with both versions', async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, 'sess_v99.jsonl'),
      `${JSON.stringify(aHeader({ sessionId: 'sess_v99', schemaVersion: 99 }))}\n`,
      'utf8',
    );

    await assert.rejects(Session.open(sessionDeps(new JsonlEventStore(dir)), 'sess_v99'), (error: unknown) => {
      if (!(error instanceof UnsupportedSchemaVersionError)) return false;
      assert.equal(error.found, 99);
      assert.deepEqual(error.supported, SUPPORTED_SCHEMA_VERSIONS);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log that exists but holds nothing is corrupt, not empty', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'sess_empty.jsonl'), '', 'utf8');

    await assert.rejects(new JsonlEventStore(dir).readAll('sess_empty'), /missing session header/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second session header in one log is corruption', () => {
  const once = reduce(initialState('sess_dup'), aHeader({ sessionId: 'sess_dup' }));

  assert.throws(() => reduce(once, aHeader({ sessionId: 'sess_dup', seq: 2 })), /not the first event/);
});
