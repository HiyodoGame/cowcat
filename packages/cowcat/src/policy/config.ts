import type { Rule } from './decide.js';
import { DEFAULT_RULES } from './defaults.js';

/**
 * What one source contributes. Every key is optional: a source that says nothing
 * about a key does not override it (ADR-025 decision 1).
 */
export interface ConfigLayer {
  readonly rules?: readonly Rule[];
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
}

/** Layer 0. Not a file, and not overridable by omission. */
export const DEFAULT_CONFIG: CowcatConfig = {
  rules: DEFAULT_RULES.map((rule) => ({ rule, origin: 'default' as const })),
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
  };
}

// Environment variables are deliberately NOT a layer (ADR-025 decision 2). The
// legacy implementation had one, which made "a setting in a project file" and "the
// same setting in the shell that launched the tool" disagree per launch — the same
// machine produced different policy depending on who started it. Whether a shell
// variable outranks a settings key is decided per key, by whichever module owns that
// key, and documented with the key. `rules` has no environment override on purpose:
// a policy expressed as a shell variable cannot be reviewed.
