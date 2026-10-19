import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_PRESETS,
  BUILTIN_PROVIDERS,
  ModelConfigError,
  createModelPort,
  loadConfig,
  resolveConfig,
  selectModel,
  type ConfigSource,
  type ResolvedModelSettings,
} from '../src/index.js';
import { replayTransport } from './support.js';

/**
 * ADR-063, in three layers: what the config file may say, how the layers merge, and how a
 * selection becomes a callable adapter. The last one is asserted against the *endpoint*
 * (through the injected transport) rather than against a mock: "which host receives the
 * key" is the fact that matters.
 */
const source = (kind: ConfigSource['kind'], text: unknown): ConfigSource => ({ kind, path: `${kind}.json`, text: JSON.stringify(text) });

function emptySettings(overrides: Partial<ResolvedModelSettings> = {}): ResolvedModelSettings {
  return { preset: null, effort: null, presets: {}, providers: {}, ...overrides };
}

test('a config file may name a preset, an effort and provider overrides', () => {
  const loaded = loadConfig([
    source('user', {
      model: {
        preset: 'acme/gpt-x',
        effort: 'high',
        presets: {
          'acme/gpt-x': {
            protocol: 'openai',
            model: 'gpt-x-2026',
            limits: { output: 4096, context: 128000 },
            toolCalls: false,
            efforts: { high: { reasoning_effort: 'high' } },
          },
        },
        providers: { acme: { baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'ACME_KEY' } },
      },
    }),
  ]);
  assert.equal(loaded.ok, true);

  const model = loaded.config.model;
  assert.equal(model.preset, 'acme/gpt-x');
  assert.equal(model.effort, 'high');
  assert.deepEqual(model.providers['acme'], { baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'ACME_KEY' });
  const custom = model.presets['acme/gpt-x'];
  assert.ok(custom !== undefined);
  assert.equal(custom.protocol, 'openai');
  assert.equal(custom.model, 'gpt-x-2026');
  assert.deepEqual(custom.limits, { output: 4096, context: 128000 });
  assert.equal(custom.toolCalls, false);
  assert.deepEqual(custom.efforts, { high: { reasoning_effort: 'high' } });
});

test('a typo inside the model section is refused with its path, not ignored', () => {
  const loaded = loadConfig([source('user', { model: { preset: 'x/y', modle: 'typo' } })]);
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors[0]?.problem ?? '', /model: .*unrecognized key|model: .*modle/);
});

test('layers merge: scalars take the last one, provider fields merge individually', () => {
  const config = resolveConfig({
    user: { model: { preset: 'anthropic/claude-sonnet-5-5', providers: { anthropic: { baseUrl: 'https://proxy.example' } } } },
    project: { model: { effort: 'high', providers: { anthropic: { apiKeyEnv: 'MY_ANTHROPIC_KEY' } } } },
  });

  assert.equal(config.model.preset, 'anthropic/claude-sonnet-5-5');
  assert.equal(config.model.effort, 'high');
  // The project layer named one field; the user's baseUrl must survive it.
  assert.deepEqual(config.model.providers['anthropic'], { baseUrl: 'https://proxy.example', apiKeyEnv: 'MY_ANTHROPIC_KEY' });
});

test('no model configured is a state, not a default', () => {
  assert.equal(BUILTIN_PRESETS['anthropic/claude-sonnet-5-5']?.toolCalls, true);
  const error = (() => {
    try {
      selectModel(emptySettings());
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof ModelConfigError);
  assert.equal(error.problem, 'not-configured');
  assert.match(error.hint ?? '', /model.*preset/);
});

test('a built-in preset resolves to its protocol, limits and environment variable', () => {
  const selection = selectModel(emptySettings({ preset: 'anthropic/claude-sonnet-5-5' }));
  assert.equal(selection.preset.protocol, 'anthropic');
  assert.equal(selection.preset.model, 'claude-sonnet-5-5');
  assert.deepEqual(selection.preset.limits, { output: 128000, context: 1000000 });
  assert.equal(selection.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(selection.baseUrl, null);
  assert.deepEqual(selection.warnings, []);
});

test('every built-in preset names a built-in provider, and the number is sourced not guessed', () => {
  for (const [id, preset] of Object.entries(BUILTIN_PRESETS)) {
    const provider = BUILTIN_PROVIDERS[id.slice(0, id.indexOf('/'))];
    assert.ok(provider !== undefined, `${id}: no provider entry`);
    assert.equal(preset.protocol, provider.protocol, `${id}: protocol disagrees with its provider`);
    assert.ok((preset.limits.output ?? 0) > 0, `${id}: no output ceiling — Anthropic refuses a request without one`);
  }
});

test('a custom preset uses the provider overrides, and toolCalls defaults to true', () => {
  const selection = selectModel(
    emptySettings({
      preset: 'acme/gpt-x',
      presets: { 'acme/gpt-x': { protocol: 'openai', model: 'gpt-x', limits: { output: 1000 } } },
      providers: { acme: { baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'ACME_KEY' } },
    }),
  );
  assert.equal(selection.preset.model, 'gpt-x');
  assert.equal(selection.preset.toolCalls, true);
  assert.deepEqual(selection.preset.limits, { output: 1000 });
  assert.equal(selection.apiKeyEnv, 'ACME_KEY');
  assert.equal(selection.baseUrl, 'https://gateway.example/v1');
});

test('a custom preset on an unknown provider says what to add', () => {
  const error = (() => {
    try {
      selectModel(emptySettings({ preset: 'acme/gpt-x', presets: { 'acme/gpt-x': { protocol: 'openai', model: 'gpt-x' } } }));
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof ModelConfigError);
  assert.equal(error.problem, 'unknown-provider');
  assert.match(error.hint ?? '', /providers\.acme/);
});

test('a preset id without a provider is malformed, and an unknown one lists what exists', () => {
  const malformed = (() => {
    try {
      selectModel(emptySettings({ preset: 'claude-sonnet-5-5' }));
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(malformed instanceof ModelConfigError);
  assert.equal(malformed.problem, 'malformed');

  const unknown = (() => {
    try {
      selectModel(emptySettings({ preset: 'acme/nope' }));
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(unknown instanceof ModelConfigError);
  assert.equal(unknown.problem, 'unknown-preset');
  assert.match(unknown.hint ?? '', /anthropic\/claude-sonnet-5-5/);
});

test('a provider whose protocol disagrees with the preset is said out loud', () => {
  const selection = selectModel(
    emptySettings({
      preset: 'anthropic/x',
      presets: { 'anthropic/x': { protocol: 'openai', model: 'x' } },
    }),
  );
  assert.equal(selection.preset.protocol, 'openai');
  assert.equal(selection.warnings.length, 1);
  assert.match(selection.warnings[0] ?? '', /built in as the anthropic protocol/);
});

test('the key is read from the environment by name, and never from config', () => {
  const selection = selectModel(emptySettings({ preset: 'deepseek/deepseek-flash' }));
  assert.equal(selection.apiKeyEnv, 'DEEPSEEK_API_KEY');

  const missing = (() => {
    try {
      createModelPort(selection, {});
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(missing instanceof ModelConfigError);
  assert.equal(missing.problem, 'missing-api-key');
  assert.match(missing.message, /DEEPSEEK_API_KEY/);
  assert.match(missing.hint ?? '', /export DEEPSEEK_API_KEY/);
});

test('the adapter goes to the configured endpoint, with the model the preset named', async () => {
  const sse = [
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-x', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('') + 'data: [DONE]\n\n';

  const transport = replayTransport(sse);
  const selection = selectModel(
    emptySettings({
      preset: 'acme/gpt-x',
      presets: { 'acme/gpt-x': { protocol: 'openai', model: 'gpt-x', limits: { output: 64 } } },
      providers: { acme: { baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'ACME_KEY' } },
    }),
  );
  const model = createModelPort(selection, { ACME_KEY: 'sk-test' }, { fetch: transport.fetch });

  const chunks = [];
  for await (const chunk of model.stream({ messages: [{ role: 'user', text: 'hi' }], tools: [], model: selection.preset.model, maxTokens: 64 }, new AbortController().signal)) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length > 0);
  assert.match(transport.requests[0]?.url ?? '', /^https:\/\/gateway\.example\/v1\//);
  assert.equal(transport.requests[0]?.body['model'], 'gpt-x');
});
