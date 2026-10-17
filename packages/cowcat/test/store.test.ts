import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStore, Session, runTurn, replay, SCHEMA_VERSION } from '../src/index.js';
import { ScriptedModel, sessionDeps, turnDeps } from './support.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

// A log must start with a header (ADR-012), so fixtures that are about some later
// line have to get that first line right.
function headerLine(sessionId: string): string {
  return JSON.stringify({
    seq: 1,
    ts: 1,
    sessionId,
    turnId: null,
    type: 'session.opened',
    schemaVersion: SCHEMA_VERSION,
    cowcatVersion: '0.0.0-test',
    shell: { kind: 'posix', executable: '/bin/sh' },
  });
}

test('JSONL store round-trips a full turn to disk and replays identically', async () => {
  const dir = tempDir();
  try {
    const store = new JsonlEventStore(dir);
    const deps = sessionDeps(store);
    const session = await Session.create(deps, 'sess_disk');
    await runTurn(
      turnDeps(session, new ScriptedModel([[{ type: 'text', text: 'saved' }]])),
      'persist me',
      new AbortController().signal,
    );

    const fromDisk = await store.readAll('sess_disk');
    assert.equal(fromDisk.length, session.state.lastSeq);
    assert.deepEqual(replay('sess_disk', fromDisk), session.state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing session reads as empty, not as an error', async () => {
  const dir = tempDir();
  try {
    assert.deepEqual(await new JsonlEventStore(dir).readAll('nope'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt line is reported with its position', async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.jsonl'), `${headerLine('bad')}\n{not json\n`, 'utf8');
    await assert.rejects(new JsonlEventStore(dir).readAll('bad'), /line 2: not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a line that is not a valid event is reported with its line and field', async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    const broken = JSON.stringify({
      seq: 2,
      ts: 2,
      sessionId: 'shape',
      turnId: 'turn_1',
      type: 'turn.transitioned',
      from: 'idle',
      to: 'nonsense',
      reason: null,
    });
    writeFileSync(join(dir, 'shape.jsonl'), `${headerLine('shape')}\n${broken}\n`, 'utf8');

    await assert.rejects(new JsonlEventStore(dir).readAll('shape'), /line 2: to: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log that does not start with a header is reported at line 1', async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    const notAHeader = JSON.stringify({
      seq: 1,
      ts: 1,
      sessionId: 'nohead',
      turnId: 'turn_1',
      type: 'turn.opened',
      input: 'hi',
    });
    writeFileSync(join(dir, 'nohead.jsonl'), `${notAHeader}\n`, 'utf8');

    await assert.rejects(
      new JsonlEventStore(dir).readAll('nohead'),
      /line 1: expected a session header, found turn.opened/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session ids that could escape the store directory are refused', async () => {
  const store = new JsonlEventStore(tempDir());
  await assert.rejects(store.readAll('../etc/passwd'), /invalid session id/);
});
