import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditRecord, AuditSink } from '../ports/audit.js';

export interface JsonlAuditSinkOptions {
  /**
   * The file to append to. The composition root picks it; the sink does not guess,
   * for the same reason the stores take their directory.
   */
  readonly file: string;
}

/**
 * One JSON object per line, appended.
 *
 * Appending rather than rewriting is the whole design: an audit trail that a later
 * run can truncate is not an audit trail. Nothing here rotates or caps the file —
 * that is a deployment concern, and doing it silently inside the sink would be the
 * kind of quiet that loses the one line somebody needed.
 */
export class JsonlAuditSink implements AuditSink {
  readonly #file: string;

  constructor(options: JsonlAuditSinkOptions) {
    this.#file = options.file;
  }

  async write(record: AuditRecord): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    await appendFile(this.#file, `${JSON.stringify(record)}\n`);
  }
}
