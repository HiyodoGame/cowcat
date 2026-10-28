import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The user layer's provider entries, as a FILE (ADR-165 ①).
 *
 * The host talks to this adapter; the layering rule puts node:fs here and nowhere else
 * (ADR-014/017). It reads the user provider catalog and offers two write paths:
 *
 *   * `readUserProviders` / `readUserProviderCatalog` — the `/providers` panel's entries and
 *     model metadata. Unreadable means "none", the trust-store precedent: a missing file is
 *     a fresh install, not an error.
 *   * `writeUserProvider` / `writeUserProviderConfiguration` — field patches or a complete
 *     provider + preset + active selection, read-modify-write, atomically (temp + rename,
 *     mode 0600, `setup`'s idiom). Existing extension fields are preserved. A document
 *     that cannot be parsed REFUSES instead of being replaced.
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

export interface ProviderConfigurationWrite {
  readonly provider: ProviderEntry;
  readonly preset: string;
  readonly definition?: import('../policy/config.js').CustomPresetSettings;
  readonly activate: boolean;
}

export interface UserProviderCatalog {
  readonly providers: Record<string, ProviderEntry>;
  readonly presets: Record<string, import('../policy/config.js').CustomPresetSettings>;
}

export async function readUserProviderCatalog(file: string): Promise<UserProviderCatalog> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(file, 'utf8')));
    const model = asRecord(parsed['model']);
    const providers: Record<string, ProviderEntry> = {};
    for (const [name, entry] of Object.entries(asRecord(model['providers']))) {
      const record = asRecord(entry);
      providers[name] = {
        ...(typeof record['baseUrl'] === 'string' ? { baseUrl: record['baseUrl'] } : {}),
        ...(typeof record['apiKeyEnv'] === 'string' ? { apiKeyEnv: record['apiKeyEnv'] } : {}),
      };
    }
    const presets: UserProviderCatalog['presets'] = {};
    for (const [id, entry] of Object.entries(asRecord(model['presets']))) {
      const record = asRecord(entry);
      const protocol = record['protocol'];
      const modelId = record['model'];
      if ((protocol !== 'openai' && protocol !== 'anthropic') || typeof modelId !== 'string' || modelId === '') continue;
      const limits = asRecord(record['limits']);
      const context = limits['context'];
      const output = limits['output'];
      presets[id] = {
        protocol,
        model: modelId,
        limits: {
          ...(typeof context === 'number' && Number.isInteger(context) && context > 0 ? { context } : {}),
          ...(typeof output === 'number' && Number.isInteger(output) && output > 0 ? { output } : {}),
        },
        ...(typeof record['toolCalls'] === 'boolean' ? { toolCalls: record['toolCalls'] } : {}),
      };
    }
    return { providers, presets };
  } catch {
    return { providers: {}, presets: {} };
  }
}

export async function readUserProviders(file: string): Promise<Record<string, ProviderEntry>> {
  return (await readUserProviderCatalog(file)).providers;
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

export async function writeUserProvider(file: string, name: string, fields: ProviderEntry): Promise<void> {
  await enqueueWrite(file, () => writeUserProviderNow(file, name, fields));
}

export async function writeUserProviderConfiguration(file: string, name: string, configuration: ProviderConfigurationWrite): Promise<void> {
  await enqueueWrite(file, () => writeUserProviderNow(file, name, configuration.provider, configuration));
}

async function writeUserProviderNow(file: string, name: string, fields: ProviderEntry, configuration?: ProviderConfigurationWrite): Promise<void> {
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
  if (configuration?.definition !== undefined) {
    const presets = asRecord(model['presets']);
    presets[configuration.preset] = {
      ...asRecord(presets[configuration.preset]),
      ...configuration.definition,
    };
    model['presets'] = presets;
  }
  if (configuration?.activate === true) model['preset'] = configuration.preset;
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
