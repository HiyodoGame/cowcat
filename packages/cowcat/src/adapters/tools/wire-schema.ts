import { z } from 'zod';

/**
 * The one place the wire form of a tool's input is decided (ADR-047).
 *
 * `io: 'input'` because a model supplies arguments rather than receiving a result, and
 * because it is what lets a `.default()` field read as optional on the wire. `target` is
 * a single constant rather than a per-tool choice: four targets disagree about unions,
 * nullability and `const`, and a tool must not be able to pick one by accident.
 *
 * The value is not a promise about any vendor — provider acceptance is unmeasured
 * (`docs/research/p5-tools.md` §12), so what is decided here is the mechanism, and a
 * calibration pass once a real endpoint exists.
 */
export const WIRE_SCHEMA = { io: 'input', target: 'draft-2020-12' } as const;

export type WireSchema = Readonly<Record<string, unknown>>;

/**
 * Constructs a tool's input schema may not use on the wire (ADR-047).
 *
 * Enforced mechanically **after** derivation rather than by reviewing zod code, because
 * the banned shapes are exactly what zod turns them into — a `z.union` of objects, for
 * instance, never produces a `type` array at all; it produces `anyOf`.
 */
export function toWireSchema(schema: z.ZodType): WireSchema {
  const raw: unknown = z.toJSONSchema(schema, WIRE_SCHEMA);
  if (!isRecord(raw)) throw new Error('zod produced a non-object JSON Schema; refusing to send it to a model');

  const problems = vocabularyProblems(raw);
  if (problems.length > 0) {
    throw new Error(
      `tool input schema uses constructs the wire vocabulary forbids (ADR-047):\n  ${problems.join('\n  ')}`,
    );
  }

  // `$schema` is pure metadata: it tells a validator which draft to apply, which no
  // model needs, and it is the one key a stricter vendor-side check is most likely to
  // object to. Dropping it costs nothing (ADR-047 decision ②).
  const wire: Record<string, unknown> = { ...raw };
  delete wire.$schema;
  return wire;
}

const UNION_KEYS = new Set(['anyOf', 'oneOf']);

// Walks the produced schema rather than the zod object: what reaches the model is the
// JSON, and a rewrite of the zod definition can change which keyword appears without
// changing the intent.
function vocabularyProblems(node: unknown, at = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => vocabularyProblems(child, `${at}[${String(index)}]`));
  }
  if (!isRecord(node)) return [];

  const problems: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const here = `${at}.${key}`;
    if (UNION_KEYS.has(key)) {
      problems.push(`${here}: a union — express the alternatives as explicit fields instead`);
      continue;
    }
    if (key === 'propertyNames') {
      problems.push(`${here}: \`z.record\` — name the keys explicitly, or use an object schema`);
      continue;
    }
    if (key === 'const') {
      problems.push(`${here}: \`z.literal\` — use \`z.enum\` with one value, or a plain field`);
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      problems.push(`${here}: a union or nullable type array — nullable values need an explicit field`);
      continue;
    }
    problems.push(...vocabularyProblems(value, here));
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
