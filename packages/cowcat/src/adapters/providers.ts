import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The user layer's provider entries, as a FILE (ADR-165 ①).
 *
 * The host talks to this adapter; the layering rule puts node:fs here and nowhere else
 * (ADR-014/017). Two verbs, both about `model.providers` in `~/.cowcat/config.json`:
 *
 *   * `readUserProviders` — the document the `/providers` panel lists. Unreadable means
 *     "none", the trust-store precedent: a missing file is a fresh install, not an error.
 *   * `writeUserProvider` — ONE entry, read-modify-write, atomically (temp + rename,
 *     mode 0600, `setup`'s idiom). A document that cannot be parsed REFUSES instead of
 *     being replaced: overwriting a hand-maintained config we could not read is how a
 *     user loses their setup.
 *
 * The secret never appears here: `apiKeyEnv` is a variable NAME (ADR-063).
 */

export interface ProviderEntry {
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
}

/** `{}` when a value is not an object; records are the only thing config JSON is made of. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function readUserProviders(file: string): Promise<Record<string, ProviderEntry>> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(file, 'utf8')));
    const model = asRecord(parsed['model']);
    const providers = asRecord(model['providers']);
    const out: Record<string, ProviderEntry> = {};
    for (const [name, entry] of Object.entries(providers)) {
      const record = asRecord(entry);
      out[name] = {
        ...(typeof record['baseUrl'] === 'string' ? { baseUrl: record['baseUrl'] } : {}),
        ...(typeof record['apiKeyEnv'] === 'string' ? { apiKeyEnv: record['apiKeyEnv'] } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

const writeQueues = new Map<string, Promise<void>>();

export async function writeUserProvider(file: string, name: string, fields: ProviderEntry): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const operation = previous.then(() => writeUserProviderNow(file, name, fields));
  const queued = operation.catch(() => undefined);
  writeQueues.set(file, queued);
  try {
    await operation;
  } finally {
    if (writeQueues.get(file) === queued) writeQueues.delete(file);
  }
}

async function writeUserProviderNow(file: string, name: string, fields: ProviderEntry): Promise<void> {
  let document: Record<string, unknown>;
  try {
    document = asRecord(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      document = {};
    } else {
      throw new Error(`${file} is not valid JSON; fix it by hand before editing providers here`);
    }
  }
  const model = asRecord(document['model']);
  const providers = asRecord(model['providers']);
  const existing = asRecord(providers[name]);
  providers[name] = {
    ...existing,
    ...(fields.baseUrl === undefined ? {} : { baseUrl: fields.baseUrl }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: fields.apiKeyEnv }),
  };
  model['providers'] = providers;
  document['model'] = model;
  const temporary = `${file}.tmp-${String(process.pid)}-${randomUUID()}`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
