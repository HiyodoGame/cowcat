import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockPort, JsonlEventStore, LockHeldError, Session } from '../src/index.js';
import { exclusiveLock, MemoryEventStore, sessionDeps } from './support.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

// Verified on this platform: process.kill(<huge>, 0) answers ESRCH, which is what a
// crashed holder's pid looks like too. No child process is spawned to get one.
const DEAD_PID = 2_147_483_647;

function lockPathOf(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.jsonl.lock`);
}

function writeLock(dir: string, sessionId: string, pid: number, nonce: string): void {
  const contents = { pid, nonce, hostname: 'some-host', startedAt: '2026-01-01T00:00:00.000Z' };
  writeFileSync(lockPathOf(dir, sessionId), `${JSON.stringify(contents)}\n`, 'utf8');
}

function readLock(dir: string, sessionId: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(lockPathOf(dir, sessionId), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return parsed as Record<string, unknown>;
}

test('acquiring a session lock writes the holder into the lock file', async () => {
  const dir = tempDir();
  try {
    const lock = await new FileLockPort(dir).acquire('sess_a');
    const contents = readLock(dir, 'sess_a');

    assert.equal(contents.pid, process.pid);
    assert.equal(contents.hostname, hostname());
    assert.equal(typeof contents.nonce, 'string');
    assert.equal(typeof contents.startedAt, 'string');

    await lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session already held is refused, naming the pid and the lock path', async () => {
  const dir = tempDir();
  try {
    const port = new FileLockPort(dir);
    await port.acquire('sess_b');

    await assert.rejects(port.acquire('sess_b'), (error: unknown) => {
      assert.ok(error instanceof LockHeldError);
      assert.equal(error.pid, process.pid);
      assert.equal(error.lockPath, lockPathOf(dir, 'sess_b'));
      assert.match(error.guidance, /another writer/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a dead writer is refused, and says the writer is gone', async () => {
  const dir = tempDir();
  try {
    writeLock(dir, 'sess_dead', DEAD_PID, 'left-behind');

    await assert.rejects(new FileLockPort(dir).acquire('sess_dead'), (error: unknown) => {
      assert.ok(error instanceof LockHeldError);
      assert.equal(error.pid, DEAD_PID);
      assert.match(error.guidance, /is gone/);
      assert.match(error.guidance, /--force-unlock/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock file that cannot be read is refused without guessing a holder', async () => {
  const dir = tempDir();
  try {
    writeFileSync(lockPathOf(dir, 'sess_bad'), 'not json\n', 'utf8');

    await assert.rejects(new FileLockPort(dir).acquire('sess_bad'), (error: unknown) => {
      assert.ok(error instanceof LockHeldError);
      assert.equal(error.pid, null);
      assert.match(error.guidance, /cannot be determined/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing a lock removes it, is idempotent, and frees the session', async () => {
  const dir = tempDir();
  try {
    const port = new FileLockPort(dir);
    const lock = await port.acquire('sess_c');
    await lock.release();
    assert.equal(existsSync(lockPathOf(dir, 'sess_c')), false);

    await lock.release();

    const again = await port.acquire('sess_c');
    assert.equal(existsSync(lockPathOf(dir, 'sess_c')), true);
    await again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing does not delete a lock we no longer own', async () => {
  const dir = tempDir();
  try {
    const lock = await new FileLockPort(dir).acquire('sess_d');
    // Stands in for a forced takeover: same path, someone else's nonce.
    writeLock(dir, 'sess_d', process.pid, 'someone-else');

    await lock.release();

    assert.equal(existsSync(lockPathOf(dir, 'sess_d')), true);
    assert.equal(readLock(dir, 'sess_d').nonce, 'someone-else');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a held lock file is invisible to the holder (the risk behind --force-unlock)', async () => {
  const dir = tempDir();
  try {
    const port = new FileLockPort(dir);
    const lock = await port.acquire('sess_e');
    // Documented residual risk: file existence cannot protect a live holder, which
    // is why --force-unlock must probe liveness before acting (research/p1-kernel.md 附录 C).
    unlinkSync(lockPathOf(dir, 'sess_e'));

    const stolen = await port.acquire('sess_e');
    assert.equal(existsSync(lockPathOf(dir, 'sess_e')), true);

    await stolen.release();
    await lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session cannot be opened twice while the first is still open', async () => {
  const dir = tempDir();
  try {
    const deps = sessionDeps(new JsonlEventStore(dir), { lock: new FileLockPort(dir) });
    const first = await Session.create(deps, 'sess_busy');

    await assert.rejects(Session.open(deps, 'sess_busy'), LockHeldError);

    await first.close();
    const reopened = await Session.open(deps, 'sess_busy');
    assert.equal(reopened.state.lastSeq, 1);
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed open does not keep the lock', async () => {
  const dir = tempDir();
  try {
    const deps = sessionDeps(new JsonlEventStore(dir), { lock: new FileLockPort(dir) });

    await assert.rejects(Session.open(deps, 'sess_absent'), /no such session/);

    // If open() had leaked the lock, our own live pid would refuse this create.
    const created = await Session.create(deps, 'sess_absent');
    assert.equal(created.state.lastSeq, 1);
    await created.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a closed session refuses to write', async () => {
  const session = await Session.create(sessionDeps(new MemoryEventStore()), 'sess_closed');
  await session.close();

  await assert.rejects(session.openTurn('hi'), /session is closed/);
});

test('the in-process lock double refuses a second holder as well', async () => {
  const lock = exclusiveLock();
  const first = await Session.create(sessionDeps(new MemoryEventStore(), { lock }), 'sess_mem');

  await assert.rejects(Session.create(sessionDeps(new MemoryEventStore(), { lock }), 'sess_mem'), LockHeldError);

  await first.close();
});
