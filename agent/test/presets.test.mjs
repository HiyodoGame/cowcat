// Preset provider/model catalog: distillation integrity + presets.js API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listProviders, getProvider, listModels, resolveModelRef,
  providerEnvVars, providerBaseURL,
} from '../src/llm/presets.js';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '../assets');
const CATALOG_PATH = join(ASSETS, 'providers.json');
const SIZE_BUDGET = 330 * 1024;
const PROTOCOLS = new Set(['anthropic', 'openai']);

const raw = readFileSync(CATALOG_PATH, 'utf8');
const catalog = JSON.parse(raw);

test('catalog: JSON parses and fits the size budget', () => {
  assert.ok(statSync(CATALOG_PATH).size <= SIZE_BUDGET,
    `providers.json is ${statSync(CATALOG_PATH).size} bytes > ${SIZE_BUDGET}`);
  assert.ok(Object.keys(catalog).length > 0);
});

test('catalog: every provider has a whitelisted protocol and required fields', () => {
  for (const [id, p] of Object.entries(catalog)) {
    assert.equal(p.id, id);
    assert.equal(typeof p.name, 'string');
    assert.ok(PROTOCOLS.has(p.protocol), `${id} has non-whitelisted protocol ${p.protocol}`);
    assert.ok(Array.isArray(p.env), `${id} env missing`);
    assert.equal(typeof p.doc, 'string');
    if (p.api !== undefined) assert.equal(typeof p.api, 'string');
    assert.ok(Array.isArray(p.models), `${id} models missing`);
    assert.ok(p.models.length > 0, `${id} has no models`);
    assert.ok(p.models.length <= 100, `${id} exceeds 100-model cap`);
  }
});

test('catalog: no deprecated models, model fields intact', () => {
  for (const p of Object.values(catalog)) {
    for (const m of p.models) {
      assert.notEqual(m.status, 'deprecated');
      assert.equal(typeof m.id, 'string');
      assert.equal(typeof m.name, 'string');
      assert.equal(typeof m.family, 'string');
      assert.equal(typeof m.reasoning, 'boolean');
      assert.equal(typeof m.attachment, 'boolean');
      assert.equal(typeof m.tool_call, 'boolean');
      assert.ok(m.limit && typeof m.limit === 'object', `${p.id}/${m.id} limit missing`);
      assert.equal(typeof m.limit.context, 'number');
      assert.equal(typeof m.limit.output, 'number');
      if (m.reasoning_options !== undefined) assert.ok(Array.isArray(m.reasoning_options));
      if (m.cost !== undefined) {
        for (const k of Object.keys(m.cost)) {
          assert.ok(['input', 'output', 'cache_read', 'cache_write'].includes(k), `${p.id}/${m.id} unexpected cost key ${k}`);
        }
      }
      if (m.status !== undefined) assert.ok(['beta', 'alpha'].includes(m.status));
    }
  }
});

test('presets: listProviders/getProvider', () => {
  const providers = listProviders();
  assert.equal(providers.length, Object.keys(catalog).length);
  assert.ok(providers.some((p) => p.id === 'anthropic'));
  assert.equal(getProvider('anthropic').protocol, 'anthropic');
  assert.equal(getProvider('does-not-exist'), null);
  assert.equal(getProvider(''), null);
  assert.equal(getProvider(null), null);
});

test('presets: listModels', () => {
  const models = listModels('openai');
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => typeof m.id === 'string'));
  assert.deepEqual(listModels('does-not-exist'), []);
  assert.deepEqual(listModels(null), []);
});

test('presets: resolveModelRef', () => {
  const hit = resolveModelRef('anthropic/claude-opus-5');
  assert.ok(hit);
  assert.equal(hit.provider.id, 'anthropic');
  assert.equal(hit.model.id, 'claude-opus-5');

  assert.equal(resolveModelRef('anthropic/no-such-model'), null);
  assert.equal(resolveModelRef('no-such-provider/claude-opus-5'), null);
  assert.equal(resolveModelRef('no-slash'), null);
  assert.equal(resolveModelRef('/leading-slash'), null);
  assert.equal(resolveModelRef('trailing-slash/'), null);
  assert.equal(resolveModelRef('a/b/extra'), null, 'model id containing / is not resolvable');
  assert.equal(resolveModelRef(''), null);
  assert.equal(resolveModelRef(null), null);
  assert.equal(resolveModelRef(42), null);
});

test('presets: providerEnvVars', () => {
  assert.deepEqual(providerEnvVars('anthropic'), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(providerEnvVars('deepseek'), ['DEEPSEEK_API_KEY']);
  assert.deepEqual(providerEnvVars('does-not-exist'), []);
  assert.deepEqual(providerEnvVars(null), []);
});

test('presets: providerBaseURL', () => {
  assert.equal(providerBaseURL('deepseek'), 'https://api.deepseek.com');
  assert.equal(providerBaseURL('moonshotai'), 'https://api.moonshot.ai/v1');
  assert.equal(providerBaseURL('anthropic'), null);
  assert.equal(providerBaseURL('does-not-exist'), null);
  assert.equal(providerBaseURL(null), null);
});

test('catalog: spot-check well-known providers', () => {
  const expected = {
    anthropic: { protocol: 'anthropic', env: ['ANTHROPIC_API_KEY'] },
    openai: { protocol: 'openai', env: ['OPENAI_API_KEY'] },
    deepseek: { protocol: 'openai', env: ['DEEPSEEK_API_KEY'], api: 'https://api.deepseek.com' },
    moonshotai: { protocol: 'openai', env: ['MOONSHOT_API_KEY'] },
    'kimi-code-plan-cn': { protocol: 'openai', env: ['KIMI_API_KEY'] },
    zhipuai: { protocol: 'openai', env: ['ZHIPU_API_KEY'] },
    siliconflow: { protocol: 'openai', env: ['SILICONFLOW_API_KEY'] },
  };
  for (const [id, want] of Object.entries(expected)) {
    const p = getProvider(id);
    assert.ok(p, `${id} missing from catalog`);
    assert.equal(p.protocol, want.protocol, `${id} protocol`);
    assert.deepEqual(p.env, want.env, `${id} env`);
    if (want.api) assert.equal(p.api, want.api, `${id} api`);
  }
  // Kimi/Moonshot models must be resolvable through the preset API.
  const kimi = listModels('kimi-code-plan-cn');
  assert.ok(kimi.length > 0);
  assert.ok(resolveModelRef(`kimi-code-plan-cn/${kimi[0].id}`), 'kimi model ref resolves');
  const moonshot = listModels('moonshotai');
  assert.ok(moonshot.length > 0);
  assert.ok(resolveModelRef(`moonshotai/${moonshot[0].id}`), 'moonshotai model ref resolves');
});
