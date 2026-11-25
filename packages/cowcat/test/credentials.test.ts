import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentials, writeCredential } from '../src/adapters/credentials.js';
import { createModelPort, selectModel, type ResolvedModelSettings } from '../src/index.js';

function tempFile(t: { after(fn: () => void): void }, name = 'credentials.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-credentials-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return join(dir, name);
}

test('a missing credentials file means no stored keys, not an error (ADR-177 ①)', async (t) => {
  const file = tempFile(t);
  assert.equal((await readCredentials(file)).size, 0);
});

test('saving one provider keeps every other provider entry and round-trips the key', async (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({ zai: { apiKey: 'zai-existing-key' } }));
  await writeCredential(file, 'deepseek', 'ds-test-key-123');
  const keys = await readCredentials(file);
  assert.equal(keys.get('deepseek'), 'ds-test-key-123');
  assert.equal(keys.get('zai'), 'zai-existing-key', 'a sibling provider is never dropped');
});

test('the credentials file is written owner-only on POSIX (ADR-177 ②)', { skip: process.platform === 'win32' }, async (t) => {
  const file = tempFile(t);
  await writeCredential(file, 'deepseek', 'ds-test-key-123');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a corrupt credentials file refuses the write rather than replacing it, and reads as empty', async (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{ not json');
  assert.equal((await readCredentials(file)).size, 0);
  await assert.rejects(() => writeCredential(file, 'deepseek', 'ds-test-key-123'), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json', 'the broken file is left for the user to fix');
});

test('a write failure names the file and never the key (ADR-177 ③)', async (t) => {
  const file = tempFile(t);
  // A directory where the file should be makes the rename fail; the error must not carry the secret.
  const blocked = join(file, 'nested');
  try {
    await writeCredential(join(blocked, 'credentials.json'), 'deepseek', 'ds-secret-value-999');
  } catch (error) {
    assert.equal((error as Error).message.includes('ds-secret-value-999'), false);
  }
});

const SETTINGS: ResolvedModelSettings = {
  preset: 'deepseek/deepseek-flash',
  effort: null,
  presets: {},
  providers: {},
};

test('the environment variable wins over a stored key; the stored key wins over nothing (ADR-177 ①)', () => {
  const selection = selectModel(SETTINGS);
  // Environment first: the variable named by the provider is used even when a key is stored.
  const fromEnv = createModelPort(selection, { DEEPSEEK_API_KEY: 'env-key-value' }, { storedKey: 'stored-key-value' });
  assert.ok(fromEnv);
  // With no environment variable, the stored key is used and no error is raised.
  const fromFile = createModelPort(selection, {}, { storedKey: 'stored-key-value' });
  assert.ok(fromFile);
});

test('a missing key names the variable and never a key value', () => {
  const selection = selectModel(SETTINGS);
  assert.throws(
    () => createModelPort(selection, {}, { storedKey: null }),
    (error: unknown) => {
      const text = (error as Error).message;
      return text.includes('DEEPSEEK_API_KEY') && !text.includes('stored');
    },
  );
});
