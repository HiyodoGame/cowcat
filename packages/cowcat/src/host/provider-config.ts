import type { ProviderConfiguration, ProviderModelSummary, ProviderSummary } from '@corescense/cowcat-protocol';
import type { UserProviderCatalog } from '../adapters/providers.js';
import type { CustomPresetSettings, ResolvedModelSettings } from '../policy/config.js';
import { BUILTIN_PRESETS, BUILTIN_PROVIDERS } from './presets.js';
import { selectModel, type ModelSelection } from './model.js';

export function providerSummaries(catalog: UserProviderCatalog, env: Readonly<Record<string, string | undefined>>): ProviderSummary[] {
  const names = new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(catalog.providers)]);
  return [...names].sort().map((name) => {
    const builtin = BUILTIN_PROVIDERS[name];
    const override = catalog.providers[name];
    const models = providerModels(name, catalog.presets);
    const protocol = builtin?.protocol ?? (models.length > 0 && models.every((model) => model.protocol === models[0]?.protocol) ? models[0]?.protocol ?? null : null);
    const apiKeyEnv = override?.apiKeyEnv ?? builtin?.apiKeyEnv ?? null;
    const baseUrl = override?.baseUrl ?? builtin?.baseUrl ?? null;
    return {
      name,
      baseUrl,
      apiKeyEnv,
      keySet: apiKeyEnv !== null && (env[apiKeyEnv] ?? '') !== '',
      custom: builtin === undefined,
      protocol,
      complete: apiKeyEnv !== null && protocol !== null && models.length > 0 && (builtin !== undefined || baseUrl !== null),
      models,
    };
  });
}

function providerModels(name: string, custom: UserProviderCatalog['presets']): ProviderModelSummary[] {
  return Object.entries({ ...BUILTIN_PRESETS, ...custom })
    .filter(([id]) => id.startsWith(`${name}/`))
    .map(([id, preset]) => ({
      id,
      protocol: preset.protocol,
      model: preset.model,
      limits: preset.limits ?? {},
      toolCalls: preset.toolCalls ?? true,
      contextWindow: preset.limits?.context ?? null,
      outputLimit: preset.limits?.output ?? null,
    }));
}

export interface ValidatedProviderConfiguration {
  readonly settings: ResolvedModelSettings;
  readonly selected: ModelSelection | null;
}

export function validateProviderConfiguration(base: ResolvedModelSettings, configuration: ProviderConfiguration): ValidatedProviderConfiguration {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(configuration.name)) throw new Error('provider id must use lowercase letters, digits and hyphens');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(configuration.apiKeyEnv)) throw new Error('apiKeyEnv must be an environment variable name, not a key value');
  const builtinProvider = BUILTIN_PROVIDERS[configuration.name];
  if (configuration.baseUrl === null && builtinProvider === undefined) throw new Error('a custom provider needs an explicit base URL');
  if (configuration.baseUrl !== null) validateEndpoint(configuration.baseUrl);
  if (!configuration.preset.startsWith(`${configuration.name}/`) || configuration.preset.length <= configuration.name.length + 1) {
    throw new Error('preset must be "<provider>/<model>" for the configured provider');
  }
  const builtinPreset = BUILTIN_PRESETS[configuration.preset];
  if (builtinProvider !== undefined && builtinProvider.protocol !== configuration.protocol) {
    throw new Error(`provider ${configuration.name} uses the ${builtinProvider.protocol} protocol`);
  }
  let definition: CustomPresetSettings | undefined;
  if (builtinPreset !== undefined) {
    if (configuration.definition !== undefined) throw new Error('a built-in preset must not be redefined');
    if (builtinPreset.protocol !== configuration.protocol) throw new Error('preset protocol does not match the provider protocol');
  } else {
    if (configuration.definition === undefined) throw new Error('a custom preset needs a complete model definition');
    if (configuration.definition.protocol !== configuration.protocol) throw new Error('provider and preset protocols must match');
    if (configuration.definition.model.trim() === '') throw new Error('model id must not be empty');
    validateLimit(configuration.definition.limits.context, 'context');
    validateLimit(configuration.definition.limits.output, 'output');
    if (configuration.protocol === 'anthropic' && configuration.definition.limits.output === undefined) {
      throw new Error('Anthropic presets require an output limit');
    }
    definition = configuration.definition;
  }
  const settings: ResolvedModelSettings = {
    ...base,
    preset: configuration.activate ? configuration.preset : base.preset,
    providers: {
      ...base.providers,
      [configuration.name]: {
        ...base.providers[configuration.name],
        ...(configuration.baseUrl === null ? {} : { baseUrl: configuration.baseUrl }),
        apiKeyEnv: configuration.apiKeyEnv,
      },
    },
    presets: definition === undefined ? base.presets : { ...base.presets, [configuration.preset]: definition },
  };
  const selected = configuration.activate
    ? selectModel({ ...settings, effort: null })
    : base.preset === null ? null : selectModel(base);
  return { settings, selected };
}

function validateEndpoint(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('base URL must use http or https');
  if (url.username !== '' || url.password !== '') throw new Error('endpoint URL must not contain credentials');
}

function validateLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error(`${name} limit must be a positive integer`);
}
