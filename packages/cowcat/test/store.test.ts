import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStore, Session, DEFAULT_RULES, runTurn, replay } from '../src/index.js';
import { fixedClock, ScriptedModel, sequentialIds } from './support.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

test('JSONL store round-trips a full turn to disk and replays identically', async () => {
  const dir = tempDir();
  try {
    const store = new JsonlEventStore(dir);
    const deps = { store, clock: fixedClock(), ids: sequentialIds() };
    const session = Session.create(deps, 'sess_disk');
    await runTurn(
      {
        session,
        model: new ScriptedModel([[{ type: 'text', text: 'saved' }]]),
        tools: new Map(),
        rules: DEFAULT_RULES,
        approve: async () => true,
        ids: sequentialIds(),
      },
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
    writeFileSync(join(dir, 'bad.jsonl'), '{"ok":true}\n{not json\n', 'utf8');
    await assert.rejects(new JsonlEventStore(dir).readAll('bad'), /line 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session ids that could escape the store directory are refused', async () => {
  const store = new JsonlEventStore(tempDir());
  await assert.rejects(store.readAll('../etc/passwd'), /invalid session id/);
});
