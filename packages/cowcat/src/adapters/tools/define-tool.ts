import { z } from 'zod';
import type { ToolGrant, ToolPort, ToolResult, ToolRisk, ToolRunContext, ToolSpec } from '../../ports/index.js';
import { toWireSchema, type WireSchema } from './wire-schema.js';

/**
 * A tool's declaration. Pure data, like `Rule` (ADR-027): the kernel reads it, the model
 * is sent it, and neither of them runs it.
 *
 * `input` is a zod schema rather than a JSON Schema because the same definition has to
 * answer two questions — "is this call valid?" (runtime) and "what shape does the model
 * see?" (wire). Writing both by hand is how the two drift apart, so the wire form is
 * derived in exactly one place (ADR-047).
 */
export interface ToolDefinition<S extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly input: S;
  /** Input field carrying the path a rule may select on — see `ToolSpec.pathInput`. */
  readonly pathInput?: string;
  /** Input field carrying a command a rule may select on — see `ToolSpec.commandInput`. */
  readonly commandInput?: string;
}

/**
 * The implementation receives the **parsed** input, never the model's raw JSON
 * (ADR-052): if it type-checks, it was validated.
 */
export type ToolImplementation<S extends z.ZodType> = (
  input: z.output<S>,
  signal: AbortSignal,
  grant: ToolGrant,
  /** The call's surroundings (ADR-108/111); most tools ignore it. */
  context?: ToolRunContext,
) => ToolResult | Promise<ToolResult>;

/**
 * Builds a `ToolPort` from a declaration and an implementation.
 *
 * Two things happen at definition time, on purpose — both are authoring errors that are
 * much cheaper to surface when a tool is loaded than when a model calls it:
 * 1. the wire schema is derived and checked against the banned vocabulary (ADR-047);
 * 2. the fields a rule narrows on are checked against that schema, because a
 *    `pathInput` naming a field that does not exist makes every path rule silently miss.
 */
export function defineTool<S extends z.ZodType>(definition: ToolDefinition<S>, run: ToolImplementation<S>): ToolPort {
  const inputSchema = toWireSchema(definition.input);
  assertObjectSchema(definition.name, inputSchema);
  assertDeclaredField(definition.name, inputSchema, 'pathInput', definition.pathInput);
  assertDeclaredField(definition.name, inputSchema, 'commandInput', definition.commandInput);

  const spec: ToolSpec = {
    name: definition.name,
    description: definition.description,
    risk: definition.risk,
    inputSchema,
    ...(definition.pathInput === undefined ? {} : { pathInput: definition.pathInput }),
    ...(definition.commandInput === undefined ? {} : { commandInput: definition.commandInput }),
  };

  return {
    spec,
    run: async (input, signal, grant, context) => {
      const parsed = definition.input.safeParse(input);
      // Invalid arguments are a result, not an exception (ADR-052): the model is told
      // which field is wrong and can retry, and the turn does not fail.
      if (!parsed.success) return { ok: false, output: describeInputProblems(definition.name, parsed.error.issues) };
      return run(parsed.data, signal, grant, context);
    },
  };
}

// A tool call's arguments are a JSON object by protocol, so anything else is a
// declaration mistake rather than a shape some provider might accept.
function assertObjectSchema(name: string, schema: WireSchema): void {
  if (schema.type !== 'object') {
    throw new Error(`${name}: a tool's input schema must be an object, got "${String(schema.type)}"`);
  }
}

// The kernel reads `ActionRequest.path` / `.command` straight off the top-level input
// (run-turn.ts `actionFields`), so the declared field has to be a top-level property.
// Silently missing it would disable the rule the declaration exists for (ADR-027).
function assertDeclaredField(name: string, schema: WireSchema, label: string, field: string | undefined): void {
  if (field === undefined) return;
  const properties: unknown = schema.properties;
  if (typeof properties !== 'object' || properties === null || !Object.hasOwn(properties, field)) {
    throw new Error(`${name}: ${label} names "${field}", which is not a property of its input schema`);
  }
}

interface InputIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

// Field paths, not prose: a model can act on "command: expected string" and cannot act
// on "validation failed". The shape is written out structurally so this file does not
// depend on a zod internal type name (ADR-052).
function describeInputProblems(name: string, issues: readonly InputIssue[]): string {
  if (issues.length === 0) return `invalid input for ${name}`;
  const lines = issues.map((issue) => `  ${formatPath(issue.path)}: ${issue.message}`);
  return [`invalid input for ${name}:`, ...lines].join('\n');
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.reduce<string>((accumulated, key) => {
    if (typeof key === 'number') return `${accumulated}[${String(key)}]`;
    return accumulated === '' ? String(key) : `${accumulated}.${String(key)}`;
  }, '');
}
