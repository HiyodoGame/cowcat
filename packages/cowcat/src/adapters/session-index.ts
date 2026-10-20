import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// `session.list` needs one fact per session — the last sequence number — and reading
// every event to get it would decode every line of every log. The store's own invariant
// makes the cheap answer correct: `JsonlEventStore.append` writes exactly one line per
// event and `seq` runs 1..n, so the number of non-empty lines IS the last `seq`.
//
// The invariant is checked where it matters instead of here: opening a session goes
// through `readAll`, which decodes and validates every line. A log this file counted
// wrongly is a log that cannot be opened.

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly lastSeq: number;
  /** The delegating session, or null for a top-level one (ADR-079 ③). */
  readonly parentSessionId: string | null;
}

export interface SessionIndexDeps {
  /** Injected so a test can describe a directory without creating one. */
  readonly readDir?: (dir: string) => Promise<readonly string[]>;
  readonly readFile?: (path: string) => Promise<string>;
}

export interface SessionIndex {
  list(): Promise<readonly SessionIndexEntry[]>;
}

const LOCK_SUFFIX = '.jsonl.lock';
const LOG_SUFFIX = '.jsonl';

export function createSessionIndex(dir: string, deps: SessionIndexDeps = {}): SessionIndex {
  const readDir = deps.readDir ?? ((path: string) => readdir(path));
  const read = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));

  return {
    async list(): Promise<readonly SessionIndexEntry[]> {
      const names = await readDir(dir).catch((error: unknown) => {
        // Nothing has been written yet is the ordinary first-run state, not a failure.
        if (isMissing(error)) return [] as readonly string[];
        throw error;
      });

      const entries: SessionIndexEntry[] = [];
      for (const name of [...names].sort()) {
        if (!name.endsWith(LOG_SUFFIX) || name.endsWith(LOCK_SUFFIX)) continue;
        const path = join(dir, name);
        // A file that cannot be read is reported rather than listed as "no events":
        // `lastSeq: 0` would be a statement about the session, and we do not have one.
        const text = await read(path);
        const lines = text.split('\n').filter((line) => line.length > 0);
        entries.push({
          sessionId: name.slice(0, -LOG_SUFFIX.length),
          lastSeq: lines.length,
          parentSessionId: parentOf(lines[0]),
        });
      }
      return entries;
    },
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

/**
 * The delegating session id from a header line, or null.
 *
 * Defensive rather than strict: this index answers "what is on disk", and it runs before any
 * session is opened. A line that is not JSON is a log `readAll` will refuse later with a real
 * message; turning it into a crash here would make one corrupt file hide every other session.
 */
function parentOf(firstLine: string | undefined): string | null {
  if (firstLine === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (!isRecord(parsed)) return null;
    const parent = parsed.parent;
    if (!isRecord(parent)) return null;
    const id = parent.sessionId;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
