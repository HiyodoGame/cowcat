import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FsPort, TrustSnapshot, TrustStore } from '../ports/index.js';

// The on-disk shape the trust record uses:
//
//   { "trusted": ["<canonical absolute path>", ...] }
//
// `version` is deliberately absent. A version field only earns its keep when a
// mismatch has a useful response, and for a list of directory names there is none —
// you cannot migrate a path you cannot interpret. What a future format change gets
// instead is the shape check: an unrecognised document reads as EMPTY plus a
// `problem`, which means "untrusted" and is the safe direction.
//
// Unknown top-level keys are preserved on write. This file is written by the tool,
// not typed by a person, so an unknown key means a newer build put it there — the
// session log's reasoning (adapters/schema.ts) and the opposite of the config file,
// which is strict precisely because a human typed it.

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Exported for the drift test: the reader and the writer must agree on the shape.
//
// Every entry must be a non-empty string, or the document is rejected as a whole.
// A tolerant filter (drop the junk, keep the rest) would read a corrupted record as
// "trusted, minus a few" and say nothing — and silence is the failure mode this
// store is documented to avoid. A record this build cannot fully understand is
// reported.
export function extractTrusted(value: unknown): readonly string[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const trusted = (value as Record<string, unknown>)['trusted'];
  if (!Array.isArray(trusted)) return null;
  if (!trusted.every((entry): entry is string => typeof entry === 'string' && entry !== '')) return null;
  return trusted;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export interface FileTrustStoreOptions {
  /**
   * Where the record lives. The composition root decides the location; the store
   * does not guess one, for the same reason `JsonlEventStore` takes a directory.
   */
  readonly file: string;
  /** Path identity (ADR-017). Used to store canonical paths and to dedupe by identity. */
  readonly fs: FsPort;
}

export class FileTrustStore implements TrustStore {
  readonly #file: string;
  readonly #fs: FsPort;

  constructor(options: FileTrustStoreOptions) {
    this.#file = options.file;
    this.#fs = options.fs;
  }

  async load(): Promise<TrustSnapshot> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      // Nothing there yet is the normal first run, not something to report.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { trusted: [], problem: null };
      return { trusted: [], problem: `cannot read ${this.#file}: ${message(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { trusted: [], problem: `${this.#file} is not valid JSON: ${message(error)}` };
    }

    const trusted = extractTrusted(parsed);
    if (trusted === null) return { trusted: [], problem: `${this.#file} has no usable "trusted" list` };
    return { trusted, problem: null };
  }

  async add(path: string): Promise<void> {
    const canonical = this.#fs.canonical(path);
    const existing = await this.#readRaw();
    const current = [...(extractTrusted(existing) ?? [])];
    // Dedupe by identity, not by text: a record written through one spelling of a
    // directory must not gain a second entry for the other spelling. The legacy
    // implementation had to do the same and said so (agent/src/trust.js:32-36).
    if (!current.some((entry) => this.#fs.samePath(entry, canonical))) current.push(canonical);
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(this.#file, `${JSON.stringify({ ...existing, trusted: current }, null, 2)}\n`);
  }

  /**
   * Drops one directory, by identity. Returns whether anything changed.
   *
   * Claims about what is trusted have to be reversible: a `deny`-shaped mistake in a
   * repository is why someone trusts a directory in the first place, and the same
   * someone has to be able to take it back without editing JSON by hand.
   */
  async remove(path: string): Promise<boolean> {
    const canonical = this.#fs.canonical(path);
    const existing = await this.#readRaw();
    const current = extractTrusted(existing) ?? [];
    const kept = current.filter((entry) => !this.#fs.samePath(entry, canonical));
    if (kept.length === current.length) return false;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(this.#file, `${JSON.stringify({ ...existing, trusted: kept }, null, 2)}\n`);
    return true;
  }

  /**
   * The file as an object, for read-modify-write. An unreadable or malformed file
   * comes back as `{}` — `add` then rewrites it with just this entry, which loses
   * nothing that could be read anyway.
   */
  async #readRaw(): Promise<Record<string, unknown>> {
    try {
      return asRecord(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch {
      return {};
    }
  }
}
