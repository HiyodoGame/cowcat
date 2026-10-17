import { z } from 'zod';
import { validateRules, type Rule, type RuleWhen } from '../policy/decide.js';
import { resolveConfig, type ConfigLayer, type ConfigLayerName, type CowcatConfig } from '../policy/config.js';

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
const documentSchema = z.strictObject({
  rules: z.array(z.unknown()).optional(),
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

  const document = documentSchema.safeParse(parsed);
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

  return { ok: true, value: { layer: rules.length === 0 ? {} : { rules }, warnings } };
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
