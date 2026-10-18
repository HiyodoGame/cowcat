import type { Rule } from './decide.js';
import { DEFAULT_RULES } from './defaults.js';
import { DEFAULT_HOME_READ_ALLOW, DEFAULT_READ_DENY, DEFAULT_WRITE_DENY } from './sandbox-defaults.js';
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
 * What one source contributes. Every key is optional: a source that says nothing
 * about a key does not override it (ADR-025 decision 1).
 */
export interface ConfigLayer {
  readonly rules?: readonly Rule[];
  readonly sandbox?: SandboxSettings;
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
}

/** Layer 0. Not a file, and not overridable by omission. */
export const DEFAULT_CONFIG: CowcatConfig = {
  rules: DEFAULT_RULES.map((rule) => ({ rule, origin: 'default' as const })),
  sandbox: DEFAULT_SANDBOX_SETTINGS,
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
  };
}

// Environment variables are deliberately NOT a layer (ADR-025 decision 2). The
// legacy implementation had one, which made "a setting in a project file" and "the
// same setting in the shell that launched the tool" disagree per launch — the same
// machine produced different policy depending on who started it. Whether a shell
// variable outranks a settings key is decided per key, by whichever module owns that
// key, and documented with the key. `rules` has no environment override on purpose:
// a policy expressed as a shell variable cannot be reviewed.
