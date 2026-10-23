import type { Rule } from './decide.js';
import { DEFAULT_RULES } from './defaults.js';
import { DEFAULT_HOME_READ_ALLOW, DEFAULT_READ_DENY, DEFAULT_WRITE_DENY } from './sandbox-defaults.js';
import type { ModelLimits, ModelProtocol } from '../kernel/preset.js';
import type { SandboxBackend, SandboxMode, SandboxNetwork } from '../ports/index.js';

/**
 * The sandbox keys a config file may set. Mirrors `SandboxProfile` field for field so
 * a reader does not have to translate, but every key is optional: a layer that says
 * nothing about `network` does not turn it off (ADR-025 decision 1).
 *
 * Paths are written the way a human writes them (`~/.npm`, `.env`, `../shared`) and are
 * resolved to canonical absolutes by `resolveSandboxProfile` — the policy layer owns
 * what a policy MEANS, and the backends only accept paths that already are identities
 * (ADR-017).
 */
export interface SandboxEnvSettings {
  /** Extra credential-shaped names to strip, on top of the built-in rule set. */
  readonly deny?: readonly string[];
}

export interface SandboxReadSettings {
  /** `workspace` binds only what is allowed; `hide` opens reads and removes the denies. */
  readonly profile?: 'workspace' | 'hide';
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface SandboxWriteSettings {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface SandboxSettings {
  readonly mode?: SandboxMode;
  readonly backend?: SandboxBackend;
  readonly network?: SandboxNetwork;
  readonly env?: SandboxEnvSettings;
  readonly read?: SandboxReadSettings;
  readonly write?: SandboxWriteSettings;
}

/**
 * The same settings after merging, with every key present. A required shape is what
 * makes the merge total: `exactOptionalPropertyTypes` would otherwise force a spread
 * per key just to say "this layer did not mention it".
 */
export interface ResolvedSandboxSettings {
  readonly mode: SandboxMode;
  readonly backend: SandboxBackend;
  readonly network: SandboxNetwork;
  readonly env: { readonly deny: readonly string[] };
  readonly read: { readonly profile: 'workspace' | 'hide'; readonly allow: readonly string[]; readonly deny: readonly string[] };
  readonly write: { readonly allow: readonly string[]; readonly deny: readonly string[] };
}

/**
 * Layer 0 for the sandbox keys.
 *
 * `light` is the default tier: redaction and the audit trail, no OS-level isolation —
 * and its copy must never imply otherwise (ADR-007). `network` is off. Writes default
 * to the workspace itself (`.`, resolved against the cwd): a sandbox that cannot write
 * the project is a sandbox users switch off within a day, which is the same empirical
 * finding the home read-allow list comes from.
 */
export const DEFAULT_SANDBOX_SETTINGS: ResolvedSandboxSettings = {
  mode: 'light',
  backend: 'auto',
  network: 'off',
  env: { deny: [] },
  read: { profile: 'workspace', allow: DEFAULT_HOME_READ_ALLOW, deny: DEFAULT_READ_DENY },
  write: { allow: ['.'], deny: DEFAULT_WRITE_DENY },
};

function mergeSandbox(base: ResolvedSandboxSettings, next: SandboxSettings | undefined): ResolvedSandboxSettings {
  if (next === undefined) return base;
  return {
    mode: next.mode ?? base.mode,
    backend: next.backend ?? base.backend,
    network: next.network ?? base.network,
    env: { deny: [...base.env.deny, ...(next.env?.deny ?? [])] },
    read: {
      profile: next.read?.profile ?? base.read.profile,
      allow: [...base.read.allow, ...(next.read?.allow ?? [])],
      deny: [...base.read.deny, ...(next.read?.deny ?? [])],
    },
    write: {
      allow: [...base.write.allow, ...(next.write?.allow ?? [])],
      deny: [...base.write.deny, ...(next.write?.deny ?? [])],
    },
  };
}

/**
 * Which model to call, and how to reach it (ADR-063).
 *
 * The shape follows the three conventions the survey found in current clients: the model
 * is **one `provider/preset` string** (opencode, aider), the key is a **reference** to an
 * environment variable and never the secret itself (Codex's `env_key`), and everything
 * about the endpoint lives in a provider entry rather than beside the model.
 */
export interface ProviderSettings {
  /** Overrides the built-in endpoint. A self-hosted gateway needs this. */
  readonly baseUrl?: string;
  /** The environment variable that holds the key. A name, never the key (ADR-063). */
  readonly apiKeyEnv?: string;
  /**
   * A key read from a **legacy v1 config** (ADR-089). It exists only in the translated
   * in-memory layer: the v2 document schema does not accept it, it is never written, and
   * it is never included in warnings or logs. New configs must use `apiKeyEnv`.
   */
  readonly apiKey?: string;
}

/**
 * A preset the config declares itself, so the built-in table never has to be the whole
 * world (ADR-063 D1). Keyed by `provider/name`, which is also what `preset` names.
 */
export interface CustomPresetSettings {
  readonly protocol: ModelProtocol;
  readonly model: string;
  readonly limits?: ModelLimits;
  /**
   * Whether the model can call tools at all. Absent means `true` here — the built-in
   * table is only for tool-calling models — but a custom preset must say so because a
   * model that cannot take tools needs a different request (ADR-046 decision ③).
   */
  readonly toolCalls?: boolean;
  /**
   * Wire parameters behind each reasoning level (ADR-046 decision ④). Deliberately
   * uninterpreted: this layer does not know any vendor's vocabulary.
   */
  readonly efforts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * What this model costs, USD per 1M tokens (ADR-131 2). Optional: a preset without
   * a price is a preset the meter will not price, tokens still count, cost stays
   * silent rather than invented.
   */
  readonly price?: import('../kernel/preset.js').PriceTable;
}

export interface ModelSettings {
  /** `provider/preset`, resolved against the built-in table plus `presets`. */
  readonly preset?: string;
  /** The reasoning level the caller asked for; the preset decides what it means. */
  readonly effort?: string;
  readonly presets?: Readonly<Record<string, CustomPresetSettings>>;
  readonly providers?: Readonly<Record<string, ProviderSettings>>;
}

/** The same settings after merging. `preset: null` means "not configured", not "default". */
export interface ResolvedModelSettings {
  readonly preset: string | null;
  readonly effort: string | null;
  readonly presets: Readonly<Record<string, CustomPresetSettings>>;
  readonly providers: Readonly<Record<string, ProviderSettings>>;
}

/**
 * Layer 0 has no model on purpose: there is no honest default. Picking one would send a
 * request to a vendor the user never chose, with a key they may not have — so "not
 * configured" stays a state the host can report instead of a guess it makes.
 */
export const DEFAULT_MODEL_SETTINGS: ResolvedModelSettings = {
  preset: null,
  effort: null,
  presets: {},
  providers: {},
};

function mergeModel(base: ResolvedModelSettings, next: ModelSettings | undefined): ResolvedModelSettings {
  if (next === undefined) return base;
  return {
    // Scalars: the last layer that named them. Maps: merged per key, the same rule the
    // sandbox lists follow — a later layer must not delete an entry by not mentioning it.
    preset: next.preset ?? base.preset,
    effort: next.effort ?? base.effort,
    // A custom preset is a unit: naming one replaces it wholesale, because redefining a
    // model is one decision. A provider entry is a bag of settings, so it merges field by
    // field — otherwise a project that only names `apiKeyEnv` would erase the user's
    // `baseUrl`.
    presets: { ...base.presets, ...next.presets },
    providers: mergeProviders(base.providers, next.providers),
  };
}

function mergeProviders(
  base: ResolvedModelSettings['providers'],
  next: Readonly<Record<string, ProviderSettings>> | undefined,
): ResolvedModelSettings['providers'] {
  if (next === undefined) return base;
  const merged: Record<string, ProviderSettings> = { ...base };
  for (const [id, entry] of Object.entries(next)) {
    merged[id] = { ...base[id], ...entry };
  }
  return merged;
}

/**
 * One MCP server definition (ADR-085). `command` + `args` is exactly the shape that
 * makes a server an executable entry point, which is why the project layer needs trust.
 * `env` is honoured only from layers the user controls; a project entry's env is
 * dropped by the composition root with a warning.
 */
export interface McpServerSettings {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpSettings {
  readonly servers?: Readonly<Record<string, McpServerSettings>>;
}

/** A server definition plus the layer that supplied it — trust is decided on the origin. */
export interface SourcedMcpServer {
  readonly settings: McpServerSettings;
  readonly origin: ConfigLayerName;
}

export interface ResolvedMcpSettings {
  readonly servers: Readonly<Record<string, SourcedMcpServer>>;
}

export const DEFAULT_MCP_SETTINGS: ResolvedMcpSettings = { servers: {} };

/**
 * A server is a unit: a later layer that names the same one replaces it wholesale, the
 * same rule custom presets follow. Merging two different `command`s field by field would
 * produce a server nobody wrote.
 */
function mergeMcp(base: ResolvedMcpSettings, layers: readonly (readonly [ConfigLayer | undefined, ConfigLayerName])[]): ResolvedMcpSettings {
  const servers: Record<string, SourcedMcpServer> = { ...base.servers };
  for (const [layer, origin] of layers) {
    for (const [name, settings] of Object.entries(layer?.mcp?.servers ?? {})) {
      servers[name] = { settings, origin };
    }
  }
  return { servers };
}

/**
 * What one source contributes. Every key is optional: a source that says nothing
 * about a key does not override it (ADR-025 decision 1).
 */
export interface ConfigLayer {
  readonly rules?: readonly Rule[];
  readonly sandbox?: SandboxSettings;
  readonly model?: ModelSettings;
  readonly mcp?: McpSettings;
  readonly otel?: OtelSettings;
}

/**
 * OTel export settings (ADR-134). Resolved from the USER layer only — the loader
 * warns and drops it anywhere else. Both fields optional; absent endpoint (here
 * and in env) keeps telemetry off.
 */
export interface OtelSettings {
  readonly endpoint?: string;
  readonly headersEnv?: string;
}

// Three layers, lowest first. The legacy implementation had seven, one of which —
// `STATE_KEYS` — was applied AFTER the CLI overrides and was documented nowhere, so
// a project's committed `sandbox` key could be silently discarded by the user's own
// state file. There is no equivalent here: runtime state is a separate store and
// never participates in config merging (ADR-025 decision 3).
export const CONFIG_LAYERS = ['user', 'project', 'session'] as const;
export type ConfigLayerName = (typeof CONFIG_LAYERS)[number];

/** Where a rule came from. `default` is the product's own baseline. */
export type RuleOrigin = 'default' | ConfigLayerName;

/**
 * A rule plus the layer it came from.
 *
 * The origin is carried because trust is a statement about the WORKSPACE, and the
 * only way to act on that is to know which rules the workspace supplied (ADR-028).
 * It is deliberately NOT a field on `Rule`: a config file must not be able to
 * declare its own origin, and `ruleSchema` is strict, so the two shapes stay apart.
 */
export interface SourcedRule {
  readonly rule: Rule;
  readonly origin: RuleOrigin;
}

/** The resolved settings the kernel runs with. */
export interface CowcatConfig {
  readonly rules: readonly SourcedRule[];
  readonly sandbox: ResolvedSandboxSettings;
  readonly model: ResolvedModelSettings;
  readonly mcp: ResolvedMcpSettings;
  readonly otel: OtelSettings | undefined;
}

/** Layer 0. Not a file, and not overridable by omission. */
export const DEFAULT_CONFIG: CowcatConfig = {
  rules: DEFAULT_RULES.map((rule) => ({ rule, origin: 'default' as const })),
  sandbox: DEFAULT_SANDBOX_SETTINGS,
  model: DEFAULT_MODEL_SETTINGS,
  mcp: DEFAULT_MCP_SETTINGS,
  otel: undefined,
};

export interface ConfigLayers {
  readonly user?: ConfigLayer;
  readonly project?: ConfigLayer;
  readonly session?: ConfigLayer;
}

/**
 * Concatenation, not override — list keys merge (ADR-026).
 *
 * Safe here for a reason worth stating: `decide` chooses a verdict by CATEGORY
 * (deny, then ask, then allow), so every rule inside one category carries the same
 * verdict. Order therefore decides only *which* rule is reported, never the
 * outcome. Concatenating can never let a later layer weaken an earlier one, and a
 * narrowing is expressed as a `deny` — which wins whatever the order (ADR-023).
 *
 * Applies the layer order once, so no caller has to remember it, and stamps each
 * rule with its origin on the way through.
 */
export function resolveConfig(layers: ConfigLayers): CowcatConfig {
  const from = (layer: ConfigLayer | undefined, origin: RuleOrigin): SourcedRule[] =>
    (layer?.rules ?? []).map((rule) => ({ rule, origin }));
  return {
    rules: [
      ...DEFAULT_CONFIG.rules,
      ...from(layers.user, 'user'),
      ...from(layers.project, 'project'),
      ...from(layers.session, 'session'),
    ],
    // Scalars take the last layer that named them; lists concatenate, the same rule the
    // rules list follows — and for the same reason: a later layer must not be able to
    // silently delete an earlier deny.
    sandbox: mergeSandbox(
      mergeSandbox(mergeSandbox(DEFAULT_SANDBOX_SETTINGS, layers.user?.sandbox), layers.project?.sandbox),
      layers.session?.sandbox,
    ),
    model: mergeModel(mergeModel(mergeModel(DEFAULT_MODEL_SETTINGS, layers.user?.model), layers.project?.model), layers.session?.model),
    mcp: mergeMcp(DEFAULT_MCP_SETTINGS, [
      [layers.user, 'user'],
      [layers.project, 'project'],
      [layers.session, 'session'],
    ]),
    // Not merged, not layered: the user layer either named it or telemetry stays off
    // (ADR-134). Nothing below can widen, move, or switch it on.
    otel: layers.user?.otel,
  };
}

// Environment variables are deliberately NOT a layer (ADR-025 decision 2). The
// legacy implementation had one, which made "a setting in a project file" and "the
// same setting in the shell that launched the tool" disagree per launch — the same
// machine produced different policy depending on who started it. Whether a shell
// variable outranks a settings key is decided per key, by whichever module owns that
// key, and documented with the key. `rules` has no environment override on purpose:
// a policy expressed as a shell variable cannot be reviewed.
