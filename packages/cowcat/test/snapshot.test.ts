import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSnapshotPort,
  JsonlEventStore,
  replay,
  SCHEMA_VERSION,
  Session,
  type SessionSnapshot,
} from '../src/index.js';
import { MemoryEventStore, sessionDeps, snapshotsReturning } from './support.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

function snapshotPathOf(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.snapshot.json`);
}

// A session with a real (short) history on disk.
async function seededSession(dir: string, sessionId: string) {
  const store = new JsonlEventStore(dir);
  const deps = sessionDeps(store);
  const session = await Session.create(deps, sessionId);
  await session.openTurn('first'); // idle -> requesting
  await session.transition('streaming');
  await session.emit({
    type: 'model.message',
    turnId: session.turnId,
    text: 'hi',
    toolCalls: [],
    reasoning: [],
    stopReason: { kind: 'end', raw: 'stop' },
  });
  await session.transition('finishing');
  await session.transition('completed');
  await session.close();
  return { deps, store, events: await store.readAll(sessionId), expected: session.state };
}

test('saving a snapshot writes one file and leaves no temporary behind', async () => {
  const dir = tempDir();
  try {
    const { deps } = await seededSession(dir, 'sess_save');
    const session = await Session.open({ ...deps, snapshots: new FileSnapshotPort(dir) }, 'sess_save');
    await session.saveSnapshot();
    await session.close();

    const file = snapshotPathOf(dir, 'sess_save');
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.tmp`), false);

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(written.schemaVersion, SCHEMA_VERSION);
    assert.equal(written.lastSeq, session.state.lastSeq);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loading reports no snapshot when there is none', async () => {
  const dir = tempDir();
  try {
    assert.equal(await new FileSnapshotPort(dir).load('sess_absent'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot that cannot be trusted reads as absent, whatever is wrong with it', async () => {
  const dir = tempDir();
  try {
    const { events } = await seededSession(dir, 'sess_bad');
    const port = new FileSnapshotPort(dir);
    const good = { schemaVersion: SCHEMA_VERSION, lastSeq: events.length, state: replay('sess_bad', events) };

    const cases: Record<string, string> = {
      'not json': 'this is not json',
      empty: '',
      'truncated': JSON.stringify(good).slice(0, 40),
      'wrong shape': JSON.stringify({ schemaVersion: SCHEMA_VERSION, lastSeq: 1, state: { nope: true } }),
      'another session': JSON.stringify({ ...good, state: { ...good.state, sessionId: 'sess_other' } }),
      'envelope disagrees with state': JSON.stringify({ ...good, lastSeq: good.lastSeq + 1 }),
      'unsupported version': JSON.stringify({ ...good, schemaVersion: 99 }),
    };

    for (const [label, contents] of Object.entries(cases)) {
      writeFileSync(snapshotPathOf(dir, 'sess_bad'), contents, 'utf8');
      const loaded = await port.load('sess_bad');
      if (label === 'unsupported version') {
        // Shape is fine, so the port hands it over; judging the version is the kernel's
        // job (ADR-012 / ADR-013), and it ignores it there.
        assert.notEqual(loaded, null, label);
      } else {
        assert.equal(loaded, null, label);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot covering the whole log is used as the state, not rebuilt', async () => {
  const store = new MemoryEventStore();
  const { events, expected } = await (async () => {
    const session = await Session.create(sessionDeps(store), 'sess_used');
    await session.openTurn('hi');
    await session.close();
    return { events: await store.readAll('sess_used'), expected: session.state };
  })();

  const covered = replay('sess_used', events);
  const deps = sessionDeps(store, {
    snapshots: snapshotsReturning({ schemaVersion: SCHEMA_VERSION, lastSeq: events.length, state: covered }),
  });
  const reopened = await Session.open(deps, 'sess_used');

  // Identity, not just equality: with every event covered there is nothing left to
  // reduce, so full replay would have built a different object.
  assert.equal(reopened.state, covered);
  assert.deepEqual(reopened.state, expected);
});

test('a snapshot behind the end of the log is extended by the remaining events', async () => {
  const dir = tempDir();
  try {
    const { events, expected } = await seededSession(dir, 'sess_stale');
    const covered = events.slice(0, 2);
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      lastSeq: covered.length,
      state: replay('sess_stale', covered),
    };

    const deps = sessionDeps(new JsonlEventStore(dir), { snapshots: snapshotsReturning(snapshot) });
    const reopened = await Session.open(deps, 'sess_stale');
    await reopened.close();

    assert.deepEqual(reopened.state, expected);
    assert.notEqual(reopened.state, snapshot.state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot claiming more events than the log holds is ignored', async () => {
  const dir = tempDir();
  try {
    const { events, expected } = await seededSession(dir, 'sess_ahead');
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      lastSeq: events.length + 5,
      state: replay('sess_ahead', events),
    };

    const deps = sessionDeps(new JsonlEventStore(dir), { snapshots: snapshotsReturning(snapshot) });
    const reopened = await Session.open(deps, 'sess_ahead');
    await reopened.close();

    assert.deepEqual(reopened.state, expected);
    assert.notEqual(reopened.state, snapshot.state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round trip: save a snapshot, then reopen and get the same state off disk', async () => {
  const dir = tempDir();
  try {
    const { expected } = await seededSession(dir, 'sess_round');
    const port = new FileSnapshotPort(dir);

    const session = await Session.open(sessionDeps(new JsonlEventStore(dir), { snapshots: port }), 'sess_round');
    await session.saveSnapshot();
    await session.close();

    const reopened = await Session.open(
      sessionDeps(new JsonlEventStore(dir), { snapshots: port }),
      'sess_round',
    );
    assert.deepEqual(reopened.state, expected);
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
