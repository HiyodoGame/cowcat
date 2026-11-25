import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The user's API keys, as a FILE (ADR-177).
 *
 * `~/.cowcat/credentials.json` maps a provider id to its secret:
 *
 *     { "deepseek": { "apiKey": "…" } }
 *
 * The layering rule puts `node:fs` here and nowhere else (ADR-014/017), so the host only
 * ever sees a `Map`-shaped answer. Three rules, all from ADR-177:
 *
 *   * Reads are forgiving: a missing or unparseable file means "no stored keys", so a
 *     broken credentials file can never stop the environment variable from working.
 *   * Writes are atomic (temp file + rename), serialized per file, and keep every other
 *     provider's entry. A file that cannot be parsed REFUSES rather than being replaced —
 *     the same idiom as `config.json`, because overwriting it would drop other secrets.
 *   * Mode 0600 on POSIX. Windows has no equivalent; the user profile's ACL is the
 *     protection there, and the docs promise no more than that.
 *
 * Nothing in this module logs, formats or returns a secret except to its direct caller.
 */

export interface StoredCredential {
  readonly apiKey: string;
}

export async function readCredentials(file: string): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>();
  try {
    const parsed = asRecord(JSON.parse(await readFile(file, 'utf8')));
    for (const [provider, entry] of Object.entries(parsed)) {
      const apiKey = asRecord(entry)['apiKey'];
      if (typeof apiKey === 'string' && apiKey.trim() !== '') keys.set(provider, apiKey);
    }
  } catch {
    // Missing or unreadable: no stored keys. Environment variables still apply.
  }
  return keys;
}

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(file: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const operation = previous.then(write);
  const queued = operation.catch(() => undefined);
  writeQueues.set(file, queued);
  return operation.finally(() => {
    if (writeQueues.get(file) === queued) writeQueues.delete(file);
  });
}

/**
 * Store one provider's key. The error text names the file and never the key, so a failed
 * write cannot leak the secret into a log or a toast.
 */
export async function writeCredential(file: string, provider: string, apiKey: string): Promise<void> {
  await enqueueWrite(file, () => writeCredentialNow(file, provider, apiKey));
}

async function writeCredentialNow(file: string, provider: string, apiKey: string): Promise<void> {
  let document: Record<string, unknown>;
  try {
    document = asRecord(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      document = {};
    } else {
      throw new Error(`${file} is not valid JSON; fix or remove it before saving a key here`);
    }
  }
  document[provider] = { ...asRecord(document[provider]), apiKey };
  const temporary = `${file}.tmp-${String(process.pid)}-${randomUUID()}`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } catch {
    // Name the failure, never the content.
    throw new Error(`could not write ${file}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
