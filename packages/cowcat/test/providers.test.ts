import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeUserProvider, writeUserProviderConfiguration } from '../src/adapters/providers.js';

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-providers-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('concurrent provider writes preserve every entry and the rest of the config', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ model: { preset: 'acme/model', providers: {} }, rules: [{ name: 'keep-me', verdict: 'ask', when: {} }] }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      writeUserProvider(file, `provider-${String(index)}`, { baseUrl: `https://provider-${String(index)}.example` }),
    ),
  );

  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    model: { preset: string; providers: Record<string, { baseUrl?: string }> };
    rules: readonly { name: string }[];
  };
  assert.equal(Object.keys(document.model.providers).length, 20);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(document.model.providers[`provider-${String(index)}`]?.baseUrl, `https://provider-${String(index)}.example`);
  }
  assert.equal(document.model.preset, 'acme/model');
  assert.equal(document.rules[0]?.name, 'keep-me');
  assert.equal(readdirSync(dir).some((name) => name.includes('.tmp')), false);
});



test('a Windows-style config path does not create a truncated parent directory', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');

  await writeUserProvider(file, 'acme', { apiKeyEnv: 'ACME_API_KEY' });

  assert.deepEqual(readdirSync(dir), ['config.json']);
  const document = JSON.parse(readFileSync(file, 'utf8')) as { model: { providers: { acme: { apiKeyEnv: string } } } };
  assert.equal(document.model.providers.acme.apiKeyEnv, 'ACME_API_KEY');
});

test('a complete provider configuration writes the endpoint, model and active preset atomically', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    model: { providers: { legacy: { baseUrl: 'https://legacy.example' } } },
    rules: [{ name: 'keep-me', verdict: 'ask', when: {} }],
  }));

  await writeUserProviderConfiguration(file, 'acme', {
    provider: { baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'ACME_API_KEY' },
    preset: 'acme/qwen3-coder',
    definition: { protocol: 'openai', model: 'qwen3-coder', limits: { context: 128000, output: 8192 }, toolCalls: true },
    activate: true,
  });

  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    model: {
      preset: string;
      providers: Record<string, unknown>;
      presets: Record<string, unknown>;
    };
    rules: readonly { name: string }[];
  };
  assert.equal(document.model.preset, 'acme/qwen3-coder');
  assert.deepEqual(document.model.providers.acme, { baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'ACME_API_KEY' });
  assert.deepEqual(document.model.presets['acme/qwen3-coder'], {
    protocol: 'openai', model: 'qwen3-coder', limits: { context: 128000, output: 8192 }, toolCalls: true,
  });
  assert.deepEqual(document.model.providers.legacy, { baseUrl: 'https://legacy.example' });
  assert.equal(document.rules[0]?.name, 'keep-me');
  assert.equal(readdirSync(dir).some((name) => name.includes('.tmp')), false);
});

test('editing a preset preserves effort, price and unknown extension fields', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    model: {
      presets: {
        'acme/model': {
          protocol: 'openai', model: 'model', limits: { context: 1000 },
          efforts: { high: { reasoning_effort: 'high' } },
          price: { input: 1, output: 2 },
          'x-vendor-option': 'keep-me',
        },
      },
    },
  }));
  await writeUserProviderConfiguration(file, 'acme', {
    provider: { baseUrl: 'https://new.example/v1', apiKeyEnv: 'ACME_API_KEY' },
    preset: 'acme/model',
    definition: { protocol: 'openai', model: 'model', limits: { context: 2000, output: 500 }, toolCalls: true },
    activate: true,
  });
  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    model: { presets: Record<string, Record<string, unknown>> };
  };
  const preset = document.model.presets['acme/model'];
  assert.ok(preset);
  assert.deepEqual(preset['efforts'], { high: { reasoning_effort: 'high' } });
  assert.deepEqual(preset['price'], { input: 1, output: 2 });
  assert.equal(preset['x-vendor-option'], 'keep-me');
  assert.deepEqual(preset['limits'], { context: 2000, output: 500 });
});
