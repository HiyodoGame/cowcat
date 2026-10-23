import { z } from 'zod';
import { validateRules, type Rule, type RuleWhen } from '../policy/decide.js';
import {
  resolveConfig,
  type ConfigLayer,
  type ConfigLayerName,
  type CowcatConfig,
  type CustomPresetSettings,
  type ModelSettings,
  type McpServerSettings,
  type McpSettings,
  type ProviderSettings,
  type SandboxSettings,
} from '../policy/config.js';

// Config decoding lives in the adapter layer, next to the code that reads the files
// (ADR-009).
//
// The objects here are STRICT, which is the opposite of the choice made for the
// session log (adapters/schema.ts). The reason is the direction the bytes travel: a
// log is written by a build and read by another build, so an unknown key means "a
// newer writer" and stripping it is right; a config file is typed by a human, so an
// unknown key is a typo — `"rulez"` — and silently ignoring it is exactly the class
// of bug ADR-025 decision 5 exists to prevent.
//
// ADR-025 decision 5 is two-tiered, and the tiers are decided by WHERE the failure
// is:
//   * the document is unusable (not JSON, not an object, an unknown top-level key) →
//     refuse, and name the source and the zod path;
//   * one entry is unusable → skip that entry, keep the rest, and warn.
// So `rules` is validated one element at a time on purpose: a schema of
// `z.array(ruleSchema)` would reject the whole file over one bad rule.

const RISKS = ['read', 'write', 'exec', 'network'] as const;
const VERDICTS = ['allow', 'ask', 'deny'] as const;

const ruleWhenSchema = z.strictObject({
  tool: z.union([z.string(), z.array(z.string())]).optional(),
  risk: z.union([z.enum(RISKS), z.array(z.enum(RISKS))]).optional(),
  path: z.string().optional(),
  command: z.string().optional(),
});

const ruleSchema = z.strictObject({
  name: z.string(),
  verdict: z.enum(VERDICTS),
  reason: z.string().optional(),
  when: ruleWhenSchema,
});

// Exported for the drift assertion in test/config.test.ts: the schema and the `Rule`
// type must keep the same key set, or a field added to one side silently stops being
// expressible on the other. Not re-exported from src/index.ts — the public surface is
// the decoded result, not the decoder.
export { ruleSchema, ruleWhenSchema };

// `rules` stays `unknown[]` here: membership is checked per entry, not by this
// schema. Everything else about the document IS checked here, which is what makes an
// unknown top-level key a refusal rather than a warning.
//
// `sandbox` is strict all the way down: unlike a rule, a sandbox key has no
// per-entry skip tier — a typo like `"network": "of"` must not quietly leave the
// network in its default state.
const sandboxEnvSchema = z.strictObject({ deny: z.array(z.string()).optional() });
const sandboxReadSchema = z.strictObject({
  profile: z.enum(['workspace', 'hide']).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});
const sandboxWriteSchema = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});
const sandboxSchema = z.strictObject({
  mode: z.enum(['off', 'light', 'system']).optional(),
  backend: z.enum(['auto', 'bwrap', 'seatbelt', 'none']).optional(),
  network: z.enum(['off', 'ask', 'on']).optional(),
  env: sandboxEnvSchema.optional(),
  read: sandboxReadSchema.optional(),
  write: sandboxWriteSchema.optional(),
});

const providerSettingsSchema = z.strictObject({
  baseUrl: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
});

// A preset the config declares itself (ADR-063 D1). Strict like everything else here: a
// typo in `protocol` must not fall back to a default adapter.
const customPresetSchema = z.strictObject({
  protocol: z.enum(['openai', 'anthropic']),
  model: z.string().min(1),
  limits: z
    .strictObject({
      output: z.number().int().positive().optional(),
      context: z.number().int().positive().optional(),
    })
    .optional(),
  toolCalls: z.boolean().optional(),
  efforts: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  // USD per 1M tokens (ADR-131). Optional: no price, no cost line — never an invented one.
  price: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative().optional(),
      cacheCreation: z.number().nonnegative().optional(),
    })
    .optional(),
});

const modelSchema = z.strictObject({
  preset: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  presets: z.record(z.string(), customPresetSchema).optional(),
  providers: z.record(z.string(), providerSettingsSchema).optional(),
});

const documentSchema = z.strictObject({
  rules: z.array(z.unknown()).optional(),
  sandbox: sandboxSchema.optional(),
  model: modelSchema.optional(),
  // The hooks section is validated and executed by the hooks adapter (ADR-123 ③), not
  // resolved into kernel config — the file layer only has to let the key through.
  hooks: z.record(z.string(), z.unknown()).optional(),
  mcp: z
    .strictObject({
      servers: z
        .record(
          z.string(),
          z.strictObject({
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export interface ConfigSource {
  readonly kind: ConfigLayerName;
  /** Where this came from, for the error message. `<session>` when it is not a file. */
  readonly path: string;
  readonly text: string;
}

/** One thing wrong with one source. The loader refuses when any of these appears. */
export interface ConfigError {
  readonly source: string;
  readonly problem: string;
}

/** One entry that was skipped. The rest of the source is kept. */
export interface ConfigWarning {
  readonly source: string;
  readonly problem: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: CowcatConfig; readonly warnings: readonly ConfigWarning[] }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

// Renders a zod issue as `rules[2].verdict: <message>`, the same shape
// adapters/schema.ts uses for a corrupt log line.
function describeIssues(issues: readonly z.core.$ZodIssue[], source: string): readonly ConfigError[] {
  return issues.map((issue) => {
    const path = issue.path.reduce<string>((acc, part) => (typeof part === 'number' ? `${acc}[${String(part)}]` : acc === '' ? String(part) : `${acc}.${String(part)}`), '');
    return { source, problem: `${path === '' ? '<document>' : path}: ${issue.message}` };
  });
}

// Builds a RuleWhen field by field, dropping what the document did not set.
//
// `exactOptionalPropertyTypes` is on, and zod's inferred optionals are the looser
// `tool?: string | undefined` — "may be absent or explicitly undefined" — while
// `RuleWhen` means "may be absent, and is never undefined when present". Spreading
// only the present fields is what bridges the two, and it is the same reason
// `toRule` does not just pass `reason` through.
function toWhen(when: z.infer<typeof ruleWhenSchema>): RuleWhen {
  return {
    ...(when.tool === undefined ? {} : { tool: when.tool }),
    ...(when.risk === undefined ? {} : { risk: when.risk }),
    ...(when.path === undefined ? {} : { path: when.path }),
    ...(when.command === undefined ? {} : { command: when.command }),
  };
}

// Turns one validated entry into a Rule, keeping `reason` genuinely absent rather
// than present-and-undefined.
function toRule(entry: z.infer<typeof ruleSchema>): Rule {
  return {
    name: entry.name,
    verdict: entry.verdict,
    when: toWhen(entry.when),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  };
}

interface DecodedSource {
  readonly layer: ConfigLayer;
  readonly warnings: readonly ConfigWarning[];
}

function decodeSource(source: ConfigSource): { readonly ok: true; readonly value: DecodedSource } | { readonly ok: false; readonly errors: readonly ConfigError[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text);
  } catch (error) {
    return { ok: false, errors: [{ source: source.path, problem: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }

  const raw = parsed;
  if (isRecord(raw) && isV1Document(raw)) return translateV1(raw, source.path);

  const document = documentSchema.safeParse(raw);
  if (!document.success) return { ok: false, errors: describeIssues(document.error.issues, source.path) };

  const warnings: ConfigWarning[] = [];
  const rules: Rule[] = [];
  const entries = document.data.rules ?? [];
  entries.forEach((entry, index) => {
    const where = `rules[${String(index)}]`;
    const single = ruleSchema.safeParse(entry);
    if (!single.success) {
      warnings.push({ source: source.path, problem: `${where}: ${single.error.issues[0]?.message ?? 'does not match the rule schema'}` });
      return;
    }
    const rule = toRule(single.data);
    // The same reporting channel T1 built for the policy layer: a rule `decide`
    // cannot honour correctly (a glob path, a relative path, the filesystem root)
    // must be skipped loudly rather than loaded and silently never match.
    const problems = validateRules([rule]);
    if (problems.length > 0) {
      warnings.push({ source: source.path, problem: `${where} (${rule.name}): ${problems[0]?.problem ?? 'unsupported'}` });
      return;
    }
    rules.push(rule);
  });

  return {
    ok: true,
    value: {
      layer: {
        ...(rules.length === 0 ? {} : { rules }),
        ...(document.data.sandbox === undefined ? {} : { sandbox: toSandbox(document.data.sandbox) }),
        ...(document.data.model === undefined ? {} : { model: toModel(document.data.model) }),
        ...(document.data.mcp === undefined ? {} : { mcp: toMcp(document.data.mcp) }),
      },
      warnings,
    },
  };
}

// Same bridge as `toSandbox`, one level deeper: a custom preset's `limits` are rebuilt
// field by field so an absent key stays absent rather than present-and-undefined.
function toCustomPreset(input: z.infer<typeof customPresetSchema>): CustomPresetSettings {
  return {
    protocol: input.protocol,
    model: input.model,
    ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
    ...(input.efforts === undefined ? {} : { efforts: input.efforts }),
    ...(input.price === undefined
      ? {}
      : {
          price: {
            input: input.price.input,
            output: input.price.output,
            ...(input.price.cacheRead === undefined ? {} : { cacheRead: input.price.cacheRead }),
            ...(input.price.cacheCreation === undefined ? {} : { cacheCreation: input.price.cacheCreation }),
          },
        }),
    limits: {
      ...(input.limits?.output === undefined ? {} : { output: input.limits.output }),
      ...(input.limits?.context === undefined ? {} : { context: input.limits.context }),
    },
  };
}

function toModel(input: z.infer<typeof modelSchema>): ModelSettings {
  return {
    ...(input.preset === undefined ? {} : { preset: input.preset }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.presets === undefined
      ? {}
      : { presets: Object.fromEntries(Object.entries(input.presets).map(([key, preset]) => [key, toCustomPreset(preset)])) }),
    ...(input.providers === undefined
      ? {}
      : { providers: Object.fromEntries(Object.entries(input.providers).map(([key, provider]) => [key, toProviderSettings(provider)])) }),
  };
}

function toProviderSettings(input: z.infer<typeof providerSettingsSchema>): ProviderSettings {
  return {
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
  };
}

// Bridges zod's "optional means absent or undefined" to `SandboxSettings`'s "absent,
// never undefined" under `exactOptionalPropertyTypes`. Spreading only the present keys
// is the same bridge `toWhen` builds for rules.
function toMcp(input: z.infer<typeof documentSchema>['mcp']): McpSettings {
  if (input?.servers === undefined) return {};
  const servers: Record<string, McpServerSettings> = {};
  for (const [name, entry] of Object.entries(input.servers)) {
    servers[name] = {
      command: entry.command,
      ...(entry.args === undefined ? {} : { args: entry.args }),
      ...(entry.env === undefined ? {} : { env: entry.env }),
    };
  }
  return { servers };
}

function toSandbox(input: z.infer<typeof sandboxSchema>): SandboxSettings {
  return {
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.backend === undefined ? {} : { backend: input.backend }),
    ...(input.network === undefined ? {} : { network: input.network }),
    ...(input.env === undefined
      ? {}
      : { env: { ...(input.env.deny === undefined ? {} : { deny: input.env.deny }) } }),
    ...(input.read === undefined
      ? {}
      : {
          read: {
            ...(input.read.profile === undefined ? {} : { profile: input.read.profile }),
            ...(input.read.allow === undefined ? {} : { allow: input.read.allow }),
            ...(input.read.deny === undefined ? {} : { deny: input.read.deny }),
          },
        }),
    ...(input.write === undefined
      ? {}
      : {
          write: {
            ...(input.write.allow === undefined ? {} : { allow: input.write.allow }),
            ...(input.write.deny === undefined ? {} : { deny: input.write.deny }),
          },
        }),
  };
}

/**
 * Decodes every source and resolves them in layer order.
 *
 * A source that fails to decode refuses the WHOLE load rather than being skipped:
 * a config file that cannot be understood is not the same as a config file with one
 * bad entry, and starting with the built-in defaults while the user believes their
 * file is in effect is the failure mode the two tiers exist to separate.
 */
export function loadConfig(sources: readonly ConfigSource[]): ConfigLoadResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];
  const layers: Partial<Record<ConfigLayerName, ConfigLayer>> = {};

  for (const source of sources) {
    const decoded = decodeSource(source);
    if (!decoded.ok) {
      errors.push(...decoded.errors);
      continue;
    }
    warnings.push(...decoded.value.warnings);
    layers[source.kind] = decoded.value.layer;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: resolveConfig(layers), warnings };
}

// ---------------------------------------------------------------------------
// v1 config compatibility (ADR-089)
// ---------------------------------------------------------------------------

/**
 * The v1 document is recognised by SHAPE, not by a version field (v1 never wrote one):
 * a string `model` (v2 requires an object) or a provider entry carrying `apiKey`.
 * A v2 document can never match: its schema refuses both.
 */
function isV1Document(document: Record<string, unknown>): boolean {
  if (typeof document['model'] === 'string') return true;
  // A v2 document with an inline `apiKey` must still be refused by the strict schema, so a
  // provider entry alone is not enough: only the absence of `model` (v1's default) plus an
  // inline key counts as v1.
  if (document['model'] !== undefined) return false;
  const providers = document['providers'];
  return isRecord(providers) && Object.values(providers).some((entry) => isRecord(entry) && typeof entry['apiKey'] === 'string');
}

function translateV1(document: Record<string, unknown>, source: string): { readonly ok: true; readonly value: DecodedSource } | { readonly ok: false; readonly errors: readonly ConfigError[] } {
  const warnings: ConfigWarning[] = [
    {
      source,
      problem: 'legacy v1 config: read in compatibility mode (ADR-089); the file is not rewritten',
    },
  ];

  const translated = translateV1Model(document, warnings, source);
  if (!translated.ok) return { ok: false, errors: [{ source, problem: translated.problem }] };

  const sandbox = translateV1Sandbox(document['sandbox'], warnings, source);
  const layer: ConfigLayer = {
    ...(translated.value === undefined ? {} : { model: translated.value }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };

  if (document['permissions'] !== undefined) {
    warnings.push({ source, problem: 'v1 permissions are not migrated: declare v2 rules under "rules" (a rule language difference, not a syntax rename)' });
  }
  const handled = new Set(['model', 'providers', 'provider', 'baseURL', 'baseUrl', 'api', 'apiKey', 'apiKeyEnv', 'sandbox', 'permissions']);
  const ignored = Object.keys(document).filter((key) => !handled.has(key));
  if (ignored.length > 0) {
    const shown = ignored.slice(0, 8).join(', ');
    warnings.push({ source, problem: `v1 keys not migrated: ${shown}${ignored.length > 8 ? ', …' : ''}` });
  }

  return { ok: true, value: { layer, warnings } };
}

function translateV1Model(
  document: Record<string, unknown>,
  warnings: ConfigWarning[],
  source: string,
): { readonly ok: true; readonly value: ModelSettings | undefined } | { readonly ok: false; readonly problem: string } {
  const flatProvider = typeof document['provider'] === 'string' && document['provider'] !== '' ? document['provider'] : null;
  const rawModel = document['model'];

  let preset: string;
  if (typeof rawModel === 'string' && rawModel !== '') {
    preset = rawModel.includes('/') || flatProvider === null ? rawModel : `${flatProvider}/${rawModel}`;
  } else if (rawModel === undefined) {
    // v1's own default; keeping it means "no model configured" cannot appear just because
    // the old file relied on the default.
    preset = 'anthropic/claude-sonnet-5-5';
  } else {
    return { ok: false, problem: 'model must be a "provider/model" string in a v1 config' };
  }
  if (!preset.includes('/') || preset.startsWith('/') || preset.endsWith('/')) {
    return { ok: false, problem: `v1 model must be "provider/model", got "${preset}"` };
  }

  const providers: Record<string, ProviderSettings> = {};
  const rawProviders = document['providers'];
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    return { ok: false, problem: 'providers must be an object in a v1 config' };
  }
  const providerRecord = isRecord(rawProviders) ? rawProviders : {};
  for (const [id, entry] of Object.entries(providerRecord)) {
    if (isRecord(entry)) providers[id] = v1Provider(entry);
  }

  // Legacy flat fields are a patch on the resolved provider (v1 semantics), so they win
  // over the same provider's entry.
  const flatBaseUrl = firstString(document['baseURL'], document['baseUrl'], document['api']);
  const flat: ProviderSettings = {
    ...(typeof document['apiKey'] === 'string' && document['apiKey'] !== '' ? { apiKey: document['apiKey'] } : {}),
    ...(typeof document['apiKeyEnv'] === 'string' && document['apiKeyEnv'] !== '' ? { apiKeyEnv: document['apiKeyEnv'] } : {}),
    ...(flatBaseUrl === null ? {} : { baseUrl: flatBaseUrl }),
  };
  if (flatProvider !== null && Object.keys(flat).length > 0) {
    providers[flatProvider] = { ...providers[flatProvider], ...flat };
  }

  if (Object.values(providers).some((provider) => provider.apiKey !== undefined)) {
    warnings.push({
      source,
      problem: 'v1 inline apiKey present: used in memory only, never written and never logged; prefer apiKeyEnv + an environment variable',
    });
  }

  return {
    ok: true,
    value: {
      preset,
      ...(Object.keys(providers).length === 0 ? {} : { providers }),
    },
  };
}

function v1Provider(entry: Record<string, unknown>): ProviderSettings {
  const apiKey = typeof entry['apiKey'] === 'string' && entry['apiKey'] !== '' ? entry['apiKey'] : undefined;
  const apiKeyEnv =
    typeof entry['apiKeyEnv'] === 'string' && entry['apiKeyEnv'] !== ''
      ? entry['apiKeyEnv']
      : Array.isArray(entry['env']) && typeof entry['env'][0] === 'string'
        ? entry['env'][0]
        : undefined;
  const baseUrl = firstString(entry['baseURL'], entry['baseUrl'], entry['api']);
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(baseUrl === null ? {} : { baseUrl }),
  };
}

function translateV1Sandbox(value: unknown, warnings: ConfigWarning[], source: string): SandboxSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value === 'off' || value === 'light' || value === 'system') return { mode: value };
    warnings.push({ source, problem: `v1 sandbox "${value}" is not a known mode; using the default` });
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push({ source, problem: 'v1 sandbox is neither a mode string nor an object; using the default' });
    return undefined;
  }
  const mode = value['mode'];
  const deny = value['envDeny'];
  return {
    ...(mode === 'off' || mode === 'light' || mode === 'system' ? { mode } : {}),
    ...(Array.isArray(deny) ? { env: { deny: deny.filter((entry): entry is string => typeof entry === 'string') } } : {}),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
