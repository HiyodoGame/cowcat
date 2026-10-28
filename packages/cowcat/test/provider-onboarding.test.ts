import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerSummaries, validateProviderConfiguration } from '../src/host/provider-config.js';
import { DEFAULT_MODEL_SETTINGS } from '../src/policy/config.js';

test('provider catalog includes built-in templates and marks name-only entries incomplete', () => {
  const rows = providerSummaries({
    providers: { local: { baseUrl: 'http://localhost:11434/v1' } },
    presets: {},
  }, { ZHIPU_API_KEY: 'not-a-secret-value-for-production' });
  const builtin = rows.find((row) => row.name === 'zai');
  assert.ok(builtin);
  assert.equal(builtin.custom, false);
  assert.equal(builtin.complete, true);
  assert.equal(builtin.keySet, true);
  assert.ok(builtin.models.length > 0);
  const local = rows.find((row) => row.name === 'local');
  assert.ok(local);
  assert.equal(local.custom, true);
  assert.equal(local.complete, false);
  assert.equal(local.models.length, 0);
});

test('a custom configuration produces a selectable model without inventing limits', () => {
  const result = validateProviderConfiguration(DEFAULT_MODEL_SETTINGS, {
    name: 'local', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'LOCAL_API_KEY',
    preset: 'local/qwen3-coder', activate: true,
    definition: { protocol: 'openai', model: 'qwen3-coder', limits: { output: 8192 }, toolCalls: true },
  });
  assert.equal(result.settings.preset, 'local/qwen3-coder');
  assert.equal(result.settings.presets['local/qwen3-coder']?.limits?.context, undefined);
  assert.ok(result.selected);
  assert.equal(result.selected.id, 'local/qwen3-coder');
  assert.equal(result.selected.baseUrl, 'http://localhost:11434/v1');
});

test('configuration refuses endpoint credentials and a missing Anthropic output limit', () => {
  assert.throws(() => validateProviderConfiguration(DEFAULT_MODEL_SETTINGS, {
    name: 'local', protocol: 'openai', baseUrl: 'https://user:password@example.com/v1', apiKeyEnv: 'LOCAL_API_KEY',
    preset: 'local/model', activate: true,
    definition: { protocol: 'openai', model: 'model', limits: {}, toolCalls: true },
  }), /credentials/);
  assert.throws(() => validateProviderConfiguration(DEFAULT_MODEL_SETTINGS, {
    name: 'local', protocol: 'anthropic', baseUrl: 'https://example.com', apiKeyEnv: 'LOCAL_API_KEY',
    preset: 'local/model', activate: true,
    definition: { protocol: 'anthropic', model: 'model', limits: {}, toolCalls: true },
  }), /output/);
});
