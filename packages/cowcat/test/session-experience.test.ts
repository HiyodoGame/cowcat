import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, formatAttachedFiles, replay, type KernelEvent } from '../src/index.js';
import { createSessionIndex } from '../src/adapters/session-index.js';
import { kernelEventSchema } from '../src/adapters/schema.js';
import { MemoryEventStore, sessionDeps } from './support.js';

/**
 * ADR-126/128: header facts (cwd/model), derived titles, and the prompt.attached fold.
 */

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the session header records cwd and model, replays, and older headers still decode', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_header', { cwd: '/repo', model: 'acme/m' });
  assert.equal(session.state.sessionId, 'sess_header');

  const header = store.events[0];
  assert.ok(header?.type === 'session.opened');
  assert.equal(header.cwd, '/repo');
  assert.equal(header.model, 'acme/m');

  // Replay reproduces the header facts; absence on older logs means "not recorded".
  const legacy: KernelEvent = {
    seq: 1,
    ts: 1,
    sessionId: 'sess_legacy',
    turnId: null,
    type: 'session.opened',
    schemaVersion: 1,
    cowcatVersion: '0.0.0',
    shell: { kind: 'posix', executable: '/bin/sh' },
  };
  const decoded = kernelEventSchema.safeParse(JSON.parse(JSON.stringify(legacy)));
  assert.equal(decoded.success, true);
  assert.equal(decoded.data.type, 'session.opened');
  assert.equal(decoded.data.cwd, undefined);
  assert.equal(decoded.data.model, undefined);
  const withFacts = kernelEventSchema.safeParse(JSON.parse(JSON.stringify(header)));
  assert.equal(withFacts.success, true);
});

test('the index derives title/cwd/model/parentRole defensively from raw logs', async (t) => {
  const dir = tempDir(t, 'cowcat-index-');
  const write = (name: string, lines: readonly unknown[]): void => {
    writeFileSync(join(dir, name), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  };

  const shell = { kind: 'posix', executable: '/bin/sh' };
  write('sess_a.jsonl', [
    { seq: 1, ts: 1, sessionId: 'sess_a', turnId: null, type: 'session.opened', schemaVersion: 1, cowcatVersion: '1', shell, cwd: '/work/app', model: 'acme/m' },
    { seq: 2, ts: 2, sessionId: 'sess_a', turnId: 'turn_1', type: 'turn.opened', input: '  给这个项目加上\nUNLICENSE 文件，先看清现状再动手  ', model: 'acme/m' },
    { seq: 3, ts: 3, sessionId: 'sess_a', turnId: 'turn_1', type: 'model.message', text: 'ok', toolCalls: [], reasoning: [], stopReason: null },
  ]);
  write('sess_fork.jsonl', [
    { seq: 1, ts: 1, sessionId: 'sess_fork', turnId: null, type: 'session.opened', schemaVersion: 1, cowcatVersion: '1', shell, parent: { sessionId: 'sess_a', role: 'fork' }, cwd: '/work/app', model: 'acme/m' },
    { seq: 2, ts: 2, sessionId: 'sess_fork', turnId: 'turn_1', type: 'turn.opened', input: 'x', model: 'acme/m' },
  ]);
  // A legacy log: no header facts at all.
  write('sess_old.jsonl', [
    { seq: 1, ts: 1, sessionId: 'sess_old', turnId: null, type: 'session.opened', schemaVersion: 1, cowcatVersion: '1', shell },
    { seq: 2, ts: 2, sessionId: 'sess_old', turnId: 'turn_1', type: 'turn.opened', input: 'legacy session', model: 'old/m' },
  ]);
  // A corrupt line must not hide the other sessions.
  writeFileSync(join(dir, 'sess_bad.jsonl'), '{ not json\n');

  const entries = await createSessionIndex(dir).list();
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));

  const a = byId.get('sess_a');
  assert.ok(a !== undefined);
  assert.equal(a.cwd, '/work/app');
  assert.equal(a.model, 'acme/m');
  assert.equal(a.parentSessionId, null);
  // Title: whitespace-collapsed, clipped at 40 chars with an ellipsis.
  assert.match(a.title ?? '', /UNLICENSE/);
  assert.ok((a.title ?? '').length <= 41);

  const fork = byId.get('sess_fork');
  assert.ok(fork !== undefined);
  assert.equal(fork.parentSessionId, 'sess_a');
  assert.equal(fork.parentRole, 'fork');
  assert.equal(fork.title, 'x');

  const old = byId.get('sess_old');
  assert.ok(old !== undefined);
  assert.equal(old.cwd, null);
  assert.equal(old.model, null);
  assert.equal(old.title, 'legacy session');

  const bad = byId.get('sess_bad');
  assert.ok(bad !== undefined, 'a corrupt log still lists (line count is the store invariant)');
  assert.equal(bad.parentSessionId, null);
  assert.equal(bad.title, null, 'but no fact is derived from garbage');
});

test('the index uses bounded head/tail reads for ordinary logs', async (t) => {
  const dir = tempDir(t, 'cowcat-index-bounded-');
  const shell = { kind: 'posix', executable: '/bin/sh' };
  const events = [
    { seq: 1, ts: 1, sessionId: 'sess_bounded', turnId: null, type: 'session.opened', schemaVersion: 1, cowcatVersion: '1', shell, cwd: '/work/app', model: 'acme/m' },
    { seq: 2, ts: 2, sessionId: 'sess_bounded', turnId: 'turn_1', type: 'turn.opened', input: 'bounded title', model: 'acme/m' },
    { seq: 3, ts: 3, sessionId: 'sess_bounded', turnId: 'turn_1', type: 'model.message', text: 'ok', toolCalls: [], reasoning: [], stopReason: null },
  ];
  writeFileSync(join(dir, 'sess_bounded.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  let wholeReads = 0;

  const entries = await createSessionIndex(dir, {
    readFile: () => {
      wholeReads += 1;
      return Promise.reject(new Error('whole-file read is not allowed for an ordinary log'));
    },
  }).list();

  assert.equal(wholeReads, 0);
  assert.equal(entries[0]?.lastSeq, 3);
  assert.equal(entries[0].title, 'bounded title');
  assert.equal(entries[0].cwd, '/work/app');
});

test('a record larger than the read window uses the whole-file fallback', async (t) => {
  const dir = tempDir(t, 'cowcat-index-large-');
  const shell = { kind: 'posix', executable: '/bin/sh' };
  const events = [
    { seq: 1, ts: 1, sessionId: 'sess_large', turnId: null, type: 'session.opened', schemaVersion: 1, cowcatVersion: '1', shell },
    { seq: 2, ts: 2, sessionId: 'sess_large', turnId: 'turn_1', type: 'model.message', text: 'x'.repeat(70_000), toolCalls: [], reasoning: [], stopReason: null },
  ];
  writeFileSync(join(dir, 'sess_large.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  let wholeReads = 0;

  const entries = await createSessionIndex(dir, {
    readFile: async (path) => {
      wholeReads += 1;
      return readFile(path, 'utf8');
    },
  }).list();

  assert.equal(wholeReads, 1);
  assert.equal(entries[0]?.lastSeq, 2);
});

test('prompt.attached folds into a user message ahead of the prompt, and replays', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_attach');
  await session.emit({
    type: 'prompt.attached',
    turnId: null,
    files: [{ name: 'notes.md', content: '# Notes\nkeep it simple' }],
  });
  await session.openTurn('总结一下这个文件');
  await session.emit({ type: 'model.message', turnId: session.turnId, text: 'ok', toolCalls: [], reasoning: [], stopReason: null });

  const messages = session.state.messages;
  const attachedMessage = messages[0];
  assert.ok(attachedMessage !== undefined && attachedMessage.role === 'user');
  assert.ok(attachedMessage.text.includes('--- notes.md ---'));
  assert.ok(attachedMessage.text.includes('keep it simple'));
  const promptMessage = messages[1];
  assert.ok(promptMessage !== undefined && promptMessage.role === 'user' && promptMessage.text.includes('总结'));

  assert.deepEqual(replay('sess_attach', store.events).messages, messages);

  // The formatter is deterministic: same files, same bytes.
  assert.equal(
    formatAttachedFiles([{ name: 'a.txt', content: 'x' }]),
    formatAttachedFiles([{ name: 'a.txt', content: 'x' }]),
  );
});

test('a session created without cwd/model records neither — absence is the legacy shape', async () => {
  const store = new MemoryEventStore();
  await Session.create(sessionDeps(store), 'sess_bare');
  const header = store.events[0];
  assert.ok(header?.type === 'session.opened');
  assert.equal('cwd' in header, false);
  assert.equal('model' in header, false);
});
