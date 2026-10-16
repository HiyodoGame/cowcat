import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { KernelEvent } from '../kernel/events.js';
import { LockHeldError, type Clock, type EventStore, type IdSource, type LockPort, type SessionLock } from '../ports/index.js';

export const systemClock: Clock = { now: () => Date.now() };

export const randomIds: IdSource = {
  next: (prefix) => `${prefix}_${randomUUID()}`,
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

// One JSON object per line, one file per session. Append-only: the log is the
// source of truth, so nothing here ever rewrites or deletes a line.
export class JsonlEventStore implements EventStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    return join(this.#dir, `${sessionId}.jsonl`);
  }

  async append(event: KernelEvent): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await appendFile(this.#file(event.sessionId), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readAll(sessionId: string): Promise<readonly KernelEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.#file(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    // append() always writes a whole line, so a log that exists and holds nothing
    // is not something this store produced. Reporting it as corrupt keeps it from
    // being extended into a headerless log (ADR-012).
    if (lines.length === 0) {
      throw new Error(`corrupt session log ${sessionId}.jsonl: missing session header`);
    }
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as KernelEvent;
      } catch {
        throw new Error(`corrupt session log ${sessionId}.jsonl at line ${String(index + 1)}`);
      }
    });
  }
}

interface LockFileContents {
  readonly pid: number;
  readonly nonce: string;
  readonly hostname: string;
  readonly startedAt: string;
}

type LockProbe =
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable' }
  | { readonly state: 'held'; readonly contents: LockFileContents };

// The session lock lives beside the log as `<sessionId>.jsonl.lock`. Claiming goes
// through open(..., 'wx') and nothing else: that is the single atomic arbitration
// point. Recovery after a crash is an explicit action, never automatic — automatic
// takeover has a constructive counterexample for both `unlink` and `rename`
// (research/p1-kernel.md 附录 C).
export class FileLockPort implements LockPort {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    return join(this.#dir, `${sessionId}.jsonl.lock`);
  }

  async acquire(sessionId: string): Promise<SessionLock> {
    const lockPath = this.#path(sessionId);
    await mkdir(this.#dir, { recursive: true });
    const nonce = randomUUID();
    const contents: LockFileContents = {
      pid: process.pid,
      nonce,
      hostname: hostname(),
      startedAt: processStartedAt(),
    };

    let handle: FileHandle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw await describeConflict(sessionId, lockPath);
    }

    try {
      await handle.writeFile(`${JSON.stringify(contents)}\n`, 'utf8');
    } catch (error) {
      // Never leave behind a lock we did not finish writing.
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    return { release: () => releaseIfOurs(lockPath, nonce) };
  }
}

// Diagnostic only (protocol rule 6): no portable way exists to read another
// process's start time, so nothing depends on this value.
function processStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function probeLock(lockPath: string): Promise<LockProbe> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable' };
  }
  const contents = asLockFileContents(parsed);
  return contents === null ? { state: 'unreadable' } : { state: 'held', contents };
}

function asLockFileContents(value: unknown): LockFileContents | null {
  if (!isRecord(value)) return null;
  const { pid, nonce, hostname: host, startedAt } = value;
  // A pid we cannot trust must never reach process.kill: 0 and negatives address a
  // process group rather than a single process.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof nonce !== 'string' || typeof host !== 'string' || typeof startedAt !== 'string') return null;
  return { pid, nonce, hostname: host, startedAt };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists, but not yours" — alive. Anything we cannot read as "no
    // such process" counts as alive on purpose: refusing to open is recoverable
    // (there is an explicit takeover path), silently sharing a live lock is not.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function describeConflict(sessionId: string, lockPath: string): Promise<LockHeldError> {
  const probe = await probeLock(lockPath);
  if (probe.state === 'absent') {
    // The holder released between our failed open() and this read. Report the
    // conflict we actually hit rather than inventing a holder.
    return new LockHeldError(sessionId, lockPath, null, 'the lock disappeared while reading it, try again');
  }
  if (probe.state === 'unreadable') {
    return new LockHeldError(
      sessionId,
      lockPath,
      null,
      'the lock file exists but its holder cannot be determined; inspect it before removing it by hand',
    );
  }
  const { pid } = probe.contents;
  if (isProcessAlive(pid)) {
    return new LockHeldError(
      sessionId,
      lockPath,
      pid,
      `another writer (pid ${String(pid)}) holds this session; close it before opening this one. ` +
        'If you are certain that writer is gone, --force-unlock takes the lock over — never while it runs',
    );
  }
  return new LockHeldError(
    sessionId,
    lockPath,
    pid,
    `writer pid ${String(pid)} is gone but left its lock file behind; ` +
      'confirm nothing else is using this session, then --force-unlock',
  );
}

async function releaseIfOurs(lockPath: string, nonce: string): Promise<void> {
  const probe = await probeLock(lockPath);
  // 'absent' is the ordinary already-released case. 'unreadable' means ownership
  // cannot be proven, so the file is left alone: deleting a lock we do not own
  // would hand the session to two writers.
  if (probe.state !== 'held' || probe.contents.nonce !== nonce) return;
  try {
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
