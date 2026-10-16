import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KernelEvent } from '../kernel/events.js';
import type { Clock, EventStore, IdSource } from '../ports/index.js';

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
