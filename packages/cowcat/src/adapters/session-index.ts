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
  /** The delegating/forking session, or null for a top-level one (ADR-079 ③/ADR-127). */
  readonly parentSessionId: string | null;
  /** Why it has a parent: delegation or a fork (ADR-127 ④). */
  readonly parentRole: string | null;
  /** Header facts, absent on every log written before ADR-126: null means "not recorded". */
  readonly cwd: string | null;
  readonly model: string | null;
  /** Derived, never stored: the first turn's prompt, clipped (ADR-126 ②). */
  readonly title: string | null;
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
        const header = headerOf(lines[0]);
        entries.push({
          sessionId: name.slice(0, -LOG_SUFFIX.length),
          lastSeq: lines.length,
          parentSessionId: header.parentSessionId,
          parentRole: header.parentRole,
          cwd: header.cwd,
          model: header.model,
          title: titleOf(lines),
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
 * Header facts (parent/cwd/model) from a header line.
 *
 * Defensive rather than strict: this index answers "what is on disk", and it runs before any
 * session is opened. A line that is not JSON is a log `readAll` will refuse later with a real
 * message; turning it into a crash here would make one corrupt file hide every other session.
 */
function headerOf(firstLine: string | undefined): {
  readonly parentSessionId: string | null;
  readonly parentRole: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
} {
  const empty = { parentSessionId: null, parentRole: null, cwd: null, model: null };
  if (firstLine === undefined) return empty;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (!isRecord(parsed)) return empty;
    const parent = parsed.parent;
    const parentId = isRecord(parent) && typeof parent.sessionId === 'string' ? parent.sessionId : null;
    const parentRole = isRecord(parent) && typeof parent.role === 'string' ? parent.role : null;
    return {
      parentSessionId: parentId !== '' ? parentId : null,
      parentRole,
      cwd: typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : null,
      model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : null,
    };
  } catch {
    return empty;
  }
}

const TITLE_MAX_CHARS = 40;

/**
 * The session title: the first turn's prompt, clipped. Derived, never stored (ADR-126 ②):
 * a title that drifts with the log is more honest than one that has to be maintained.
 * Blank input (an attachment-only first turn) yields null rather than an empty title.
 */
function titleOf(lines: readonly string[]): string | null {
  // The first turn.opened is near the top in practice; the cap bounds the scan on logs
  // that open with long system phases without decoding more than we need.
  for (const line of lines.slice(0, 50)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'turn.opened') continue;
    if (typeof parsed.input !== 'string') return null;
    const oneLine = parsed.input.replace(/\s+/g, ' ').trim();
    if (oneLine === '') return null;
    return oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS)}…`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
