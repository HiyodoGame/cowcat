import type { ModelPreset } from '../kernel/preset.js';
import type { ModelPort } from '../ports/index.js';
import type { ProviderSettings, ResolvedModelSettings } from '../policy/config.js';
import { anthropicModel } from '../adapters/model-anthropic.js';
import { openAIModel } from '../adapters/model-openai.js';
import { BUILTIN_PRESETS, BUILTIN_PROVIDERS } from './presets.js';

/**
 * Turning `model.preset` into something that can be called (ADR-063).
 *
 * Two steps, kept apart on purpose: selecting (pure, no environment) and building the
 * adapter (reads the key). That split is what lets `doctor` check the selection without
 * a key, and a test assert the endpoint without a network.
 */

export type ModelConfigProblem =
  | 'not-configured'
  | 'malformed'
  | 'unknown-preset'
  | 'unknown-provider'
  | 'protocol-mismatch'
  | 'missing-api-key';

/**
 * Refused, with a hint. Every failure here is something a person can fix in one line of
 * config, so the message says which line — the same discipline as the tool refusals.
 */
export class ModelConfigError extends Error {
  readonly problem: ModelConfigProblem;
  readonly hint: string | null;

  constructor(problem: ModelConfigProblem, message: string, hint: string | null = null) {
    super(message);
    this.name = 'ModelConfigError';
    this.problem = problem;
    this.hint = hint;
  }
}

export interface ModelSelection {
  /** `provider/preset`, the id the config named. */
  readonly id: string;
  readonly preset: ModelPreset;
  /** `null` when the config did not ask for a level. */
  readonly effort: string | null;
  readonly provider: string;
  readonly apiKeyEnv: string;
  /** `null` means the SDK's default endpoint. */
  readonly baseUrl: string | null;
  /**
   * Coherence problems that are not fatal. Today only "the provider's built-in protocol
   * disagrees with the preset's" — worth saying out loud, because it almost always means
   * one of the two was typed by hand.
   */
  readonly warnings: readonly string[];
}

function splitPresetId(id: string): { readonly provider: string; readonly name: string } {
  const index = id.indexOf('/');
  if (index <= 0 || index === id.length - 1) {
    throw new ModelConfigError(
      'malformed',
      `model.preset must be "provider/preset", got "${id}"`,
      'for example: "anthropic/claude-sonnet-5-5"',
    );
  }
  return { provider: id.slice(0, index), name: id.slice(index + 1) };
}

export function selectModel(settings: ResolvedModelSettings): ModelSelection {
  if (settings.preset === null) {
    throw new ModelConfigError(
      'not-configured',
      'no model is configured',
      'set "model": { "preset": "anthropic/claude-sonnet-5-5" } in your config (cowcat doctor lists the built-in ids)',
    );
  }

  const { provider } = splitPresetId(settings.preset);
  const custom = settings.presets[settings.preset];
  const preset = custom === undefined ? BUILTIN_PRESETS[settings.preset] : customToPreset(custom);

  if (preset === undefined) {
    const known = [...Object.keys(BUILTIN_PRESETS), ...Object.keys(settings.presets)].sort();
    throw new ModelConfigError(
      'unknown-preset',
      `unknown model preset: ${settings.preset}`,
      `known presets: ${known.join(', ')} — or declare it under model.presets`,
    );
  }

  const builtin = BUILTIN_PROVIDERS[provider];
  const override: ProviderSettings | undefined = settings.providers[provider];
  const apiKeyEnv = override?.apiKeyEnv ?? builtin?.apiKeyEnv;
  const baseUrl = override?.baseUrl ?? builtin?.baseUrl ?? null;

  if (apiKeyEnv === undefined) {
    throw new ModelConfigError(
      'unknown-provider',
      `unknown provider: ${provider}`,
      `add providers.${provider} with apiKeyEnv and baseUrl, or use a built-in provider (${Object.keys(BUILTIN_PROVIDERS).join(', ')})`,
    );
  }

  const warnings: string[] = [];
  if (builtin !== undefined && builtin.protocol !== preset.protocol) {
    warnings.push(
      `provider "${provider}" is built in as the ${builtin.protocol} protocol, but the preset "${settings.preset}" says ${preset.protocol}; the preset wins`,
    );
  }

  return {
    id: settings.preset,
    preset,
    effort: settings.effort,
    provider,
    apiKeyEnv,
    baseUrl,
    warnings,
  };
}

/** A config-declared preset, completed with the defaults `ModelPreset` requires. */
function customToPreset(custom: NonNullable<ResolvedModelSettings['presets'][string]>): ModelPreset {
  return {
    protocol: custom.protocol,
    model: custom.model,
    limits: custom.limits ?? {},
    // Absent means "it can call tools": the built-in table is for tool-calling models,
    // and a preset that says nothing is the common case.
    toolCalls: custom.toolCalls ?? true,
    ...(custom.efforts === undefined ? {} : { efforts: custom.efforts }),
  };
}

export interface CreateModelOptions {
  /**
   * Where the bytes come from. Injected for the same reason the adapters inject it
   * (ADR-042): a test asserts the endpoint and the mapping without reaching the network.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The key is read here and only here — from the environment, by the name the config or
 * the built-in table gave (ADR-063 D3). It is never written to config, a log or an error
 * message.
 */
export function createModelPort(
  selection: ModelSelection,
  env: Readonly<Record<string, string | undefined>>,
  options: CreateModelOptions = {},
): ModelPort {
  const apiKey = env[selection.apiKeyEnv];
  if (apiKey === undefined || apiKey === '') {
    throw new ModelConfigError(
      'missing-api-key',
      `${selection.apiKeyEnv} is not set`,
      `export ${selection.apiKeyEnv}=… (the key is read from the environment; it is never read from the config file)`,
    );
  }

  const baseURL = selection.baseUrl === null ? {} : { baseURL: selection.baseUrl };
  const fetch = options.fetch === undefined ? {} : { fetch: options.fetch };

  return selection.preset.protocol === 'anthropic'
    ? anthropicModel({ apiKey, ...baseURL, ...fetch })
    : openAIModel({ apiKey, ...baseURL, ...fetch });
}
