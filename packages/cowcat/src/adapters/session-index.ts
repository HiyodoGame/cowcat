import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// `session.list` needs the header, first title and last seq. Ordinary logs answer those
// from a bounded prefix and suffix instead of reading every byte of every session (ADR-170).

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

interface ReadSliceResult {
  readonly text: string;
  readonly bytesRead: number;
}

export interface SessionIndexDeps {
  readonly readDir?: (dir: string) => Promise<readonly string[]>;
  /** Whole-file fallback for corrupt input and records larger than the read window. */
  readonly readFile?: (path: string) => Promise<string>;
  readonly readSlice?: (path: string, start: number, length: number) => Promise<ReadSliceResult>;
  readonly stat?: (path: string) => Promise<{ readonly size: number }>;
}

export interface SessionIndex {
  list(): Promise<readonly SessionIndexEntry[]>;
}

const LOCK_SUFFIX = '.jsonl.lock';
const LOG_SUFFIX = '.jsonl';
const READ_WINDOW_BYTES = 65_536;

export function createSessionIndex(dir: string, deps: SessionIndexDeps = {}): SessionIndex {
  const readDir = deps.readDir ?? ((path: string) => readdir(path));
  const readWhole = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const readSlice = deps.readSlice ?? sliceFromDisk;
  const fileStat = deps.stat ?? ((path: string) => stat(path));

  const readLog = async (path: string): Promise<{ readonly lines: readonly string[]; readonly lastSeq: number }> => {
    const fallback = async (): Promise<{ readonly lines: readonly string[]; readonly lastSeq: number }> => {
      const lines = (await readWhole(path)).split('\n').filter((line) => line.length > 0);
      return { lines, lastSeq: lines.length };
    };
    const { size } = await fileStat(path);
    if (size === 0) return { lines: [], lastSeq: 0 };

    const headLength = Math.min(size, READ_WINDOW_BYTES);
    const head = await readSlice(path, 0, headLength);
    const headHasMore = head.bytesRead < size;
    const headLines = head.text.split('\n');
    if (headHasMore) headLines.pop();
    const tailStart = Math.max(0, size - READ_WINDOW_BYTES);
    const tail = await readSlice(path, tailStart, size - tailStart);
    let tailLines = tail.text.split('\n').filter((line) => line.length > 0);
    if (tailStart > 0) tailLines = tailLines.slice(1);
    const lastLine = tailLines.at(-1);
    const lastSeq = lastLine === undefined ? null : seqOf(lastLine);

    if (lastSeq === null || headLines.length === 0 || (headHasMore && !head.text.includes('\n'))) return fallback();
    const title = titleOf(headLines);
    // A missing title inside an incomplete first-50 window is not yet a fact: the first
    // turn may be just beyond the prefix. Read the whole log only for that unusual shape.
    if (title === null && headHasMore && headLines.length < 50) return fallback();
    return { lines: headLines, lastSeq };
  };

  return {
    async list(): Promise<readonly SessionIndexEntry[]> {
      const names = await readDir(dir).catch((error: unknown) => {
        if (isMissing(error)) return [] as readonly string[];
        throw error;
      });

      const entries: SessionIndexEntry[] = [];
      for (const name of [...names].sort()) {
        if (!name.endsWith(LOG_SUFFIX) || name.endsWith(LOCK_SUFFIX)) continue;
        const path = join(dir, name);
        const { lines, lastSeq } = await readLog(path);
        const header = headerOf(lines[0]);
        entries.push({
          sessionId: name.slice(0, -LOG_SUFFIX.length),
          lastSeq,
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

async function sliceFromDisk(path: string, start: number, length: number): Promise<ReadSliceResult> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf8', 0, bytesRead), bytesRead };
  } finally {
    await handle.close();
  }
}

function seqOf(line: string): number | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq <= 0) return null;
    return parsed.seq;
  } catch {
    return null;
  }
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
    // Role is whitelisted, not merely string-checked: this hand-rolled parse never runs
    // the schema, and an unknown role would otherwise ride the summary as garbage
    // (review of #173, P2-8).
    const rawRole = isRecord(parent) && typeof parent.role === 'string' ? parent.role : null;
    const parentRole = rawRole === 'explore' || rawRole === 'general' || rawRole === 'fork' ? rawRole : null;
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
