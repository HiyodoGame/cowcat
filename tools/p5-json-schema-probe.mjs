#!/usr/bin/env node
// Probe: what does zod 4's z.toJSONSchema() actually emit for a tool schema?
//
// Why this exists: P5 has to answer "how does a tool's zod schema become the JSON
// Schema a model is shown" (dev-plan-v2.md, P5 调研问题 1). The answer decides three
// things that are expensive to get wrong: whether a tool can declare its input ONCE
// (zod) and have the wire form derived, whether the producer needs to restrict which
// zod types a tool may use, and whether the emitted document can be handed to
// OpenAI's `parameters` / Anthropic's `input_schema` unmodified.
//
// The project's own rule (tools/policy-decide-probe.mjs): a probe that only prints is
// a probe that cannot fail. So each case states its expectation up front and is
// compared against what the installed zod really produces; a mismatch exits non-zero.
// Measured against the zod version this repo pins — run `npm ls zod` to see it.
//
// Usage: node tools/p5-json-schema-probe.mjs
// Requires nothing built: zod is imported from packages/cowcat/node_modules.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZOD = join(ROOT, 'packages', 'cowcat', 'node_modules', 'zod', 'index.js');

if (!existsSync(ZOD)) {
  console.error(`cannot find zod at ${ZOD} — run "npm install" in packages/cowcat first`);
  process.exit(2);
}

// pathToFileURL, not the raw path: import() of "F:\..." is rejected by the ESM
// loader with ERR_UNSUPPORTED_ESM_URL_SCHEME (AGENTS.md).
const { z, toJSONSchema } = await import(pathToFileURL(ZOD).href);

const failures = [];
let cases = 0;

function check(label, expectation, actual) {
  cases += 1;
  const ok = expectation === actual;
  if (!ok) failures.push({ label, expectation, actual });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
  return actual;
}

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.constructor.name}: ${error.message.split('\n')[0]}` : String(error);
  }
}

console.log(`zod = ${(await import(pathToFileURL(join(ROOT, 'packages', 'cowcat', 'node_modules', 'zod', 'package.json')).href, { with: { type: 'json' } })).default.version}`);
console.log('(actual values; expectations are asserted below each call)');

// ---------------------------------------------------------------- case 1: shape
// A tool schema of the kind P5 will actually write: required scalars, an optional
// flag, an enum, and an array of objects.
const readLike = z.object({
  file_path: z.string().describe('Absolute path of the file to read'),
  offset: z.number().int().optional(),
  limit: z.number().int().optional(),
  match: z.enum(['content', 'files', 'count']).optional(),
  todos: z
    .array(z.object({ content: z.string(), status: z.enum(['pending', 'done']) }))
    .optional(),
});

const emitted = toJSONSchema(readLike);
console.log('\n--- case 1: emitted document ---');
console.log(JSON.stringify(emitted, null, 2));

check('emits $schema by default', true, '$schema' in emitted);
check('required lists only non-optional properties', 'file_path', (emitted.required ?? []).join(','));
check('optional properties stay out of required', false, (emitted.required ?? []).includes('offset'));
check('enum survives', true, JSON.stringify(emitted).includes('"enum"'));
check('nested object array survives', true, JSON.stringify(emitted).includes('"items"'));
check('objects are closed: additionalProperties:false', false, emitted.additionalProperties);
check('int bounds are emitted as minimum/maximum', true, 'minimum' in emitted.properties.offset);
check(
  'a passthrough object is left open instead (={}, not true)',
  '{}',
  JSON.stringify(toJSONSchema(z.object({ a: z.string() }).passthrough()).additionalProperties),
);

// ------------------------------------------------- case 2: io, and dropping $schema
// `io: 'input'` is the semantically right mode (the model supplies the input), and it
// changes two things that a decision depends on.
const requiredShape = z.object({ a: z.string(), b: z.number().int(), c: z.string().optional() });
const outMode = toJSONSchema(requiredShape);
const inMode = toJSONSchema(requiredShape, { io: 'input' });
check('output mode closes objects', false, outMode.additionalProperties);
check('input mode drops additionalProperties', false, 'additionalProperties' in inMode);
check('input mode keeps required for non-default fields', 'a,b', (inMode.required ?? []).join(','));
check(
  'input mode makes a .default() field non-required',
  undefined,
  (toJSONSchema(z.object({ a: z.string(), d: z.string().default('y') }), { io: 'input' }).required ?? []).find(
    (k) => k === 'd',
  ),
);

// Some OpenAI-compatible endpoints forward `parameters` to a validator that objects
// to keys it does not know; `$schema` is the one key that is pure metadata.
const stripped = toJSONSchema(requiredShape);
delete stripped.$schema;
check('$schema is a plain data key (removable in place)', false, '$schema' in stripped);

// ------------------------------------------------- case 3: where $ref appears
// Reusing one schema object in two places is the natural way to write a tool arg
// type; whether that becomes $defs/$ref matters because a `$ref` is the part a
// provider-side validator is most likely to refuse.
const has = (doc, key) => JSON.stringify(doc).includes(`"${key}"`);
const reuse = z.object({ from: z.string(), to: z.string() });
const pair = z.object({ a: reuse, b: reuse });
const pairJson = toJSONSchema(pair);
check('reused sub-schemas are INLINED by default (no $ref)', false, has(pairJson, '$ref'));
check(
  'reused:"ref" extracts them as $defs + $ref instead',
  true,
  has(toJSONSchema(pair, { reused: 'ref' }), '$ref') && has(toJSONSchema(pair, { reused: 'ref' }), '$defs'),
);

const inlined = toJSONSchema(
  z.object({
    a: z.object({ from: z.string(), to: z.string() }),
    b: z.object({ from: z.string(), to: z.string() }),
  }),
);
check('distinct object literals inline (no $ref)', false, has(inlined, '$ref'));

// A recursive schema is the one case that cannot inline: cycles default to $defs.
const node = z.lazy(() => z.object({ child: node.optional() }));
const cyclic = toJSONSchema(node);
check('a cycle is broken with $defs/$ref', true, has(cyclic, '$ref'));

// ------------------------------------------------- case 4: unions and records
// The measured surprise: a union of primitives is NOT `anyOf` — draft-2020-12 writes
// `"type": ["string","number"]`, and `nullable` becomes `"type": [...,"null"]`. That is
// a draft-2020-12 shape a provider-side validator may or may not implement, so the
// target is part of the decision rather than a detail.
const union = toJSONSchema(z.object({ v: z.union([z.string(), z.number()]) }));
check('a union of primitives becomes a type ARRAY', '["string","number"]', JSON.stringify(union.properties.v.type));
check('and NOT anyOf', false, has(union, 'anyOf'));
const unionOpenApi = toJSONSchema(z.object({ v: z.union([z.string(), z.number()]) }), { target: 'openapi-3.0' });
check('under target:openapi-3.0 the same union becomes anyOf', true, has(unionOpenApi, 'anyOf'));
check(
  'nullable becomes a type array too',
  '["string","null"]',
  JSON.stringify(toJSONSchema(z.object({ w: z.string().nullable() })).properties.w.type),
);
const disc = toJSONSchema(
  z.object({
    v: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ]),
  }),
);
check('discriminatedUnion becomes oneOf', true, has(disc, 'oneOf'));

const rec = toJSONSchema(z.object({ env: z.record(z.string(), z.string()) }));
check('record becomes additionalProperties carrying the value schema', '{"type":"string"}', JSON.stringify(rec.properties.env.additionalProperties));
check('record also gets propertyNames', true, has(rec.properties.env, 'propertyNames'));
check(
  'target:draft-04 drops propertyNames for a record',
  false,
  has(toJSONSchema(z.object({ env: z.record(z.string(), z.string()) }), { target: 'draft-04' }).properties.env, 'propertyNames'),
);

// `$schema` itself is target-dependent: 2020-12/draft-07/draft-04 each emit their own
// URL, while openapi-3.0 emits none at all.
check('openapi-3.0 emits no $schema key', false, '$schema' in unionOpenApi);

// --------------------------------------- case 5: types JSON Schema cannot carry
// If these throw, the tool-authoring rule is "the input schema is a JSON Schema
// subset", and the throw is the enforcement point.
const dateThrow = throws(() => toJSONSchema(z.object({ when: z.date() })));
check('z.date() is rejected, not silently guessed', true, dateThrow !== null);
console.log(`     (${dateThrow ?? 'did not throw'})`);
const bigintThrow = throws(() => toJSONSchema(z.object({ n: z.bigint() })));
check('z.bigint() is rejected', true, bigintThrow !== null);
console.log(`     (${bigintThrow ?? 'did not throw'})`);
const fnThrow = throws(() => toJSONSchema(z.object({ cb: z.function() })));
check('z.function() is rejected', true, fnThrow !== null);
console.log(`     (${fnThrow ?? 'did not throw'})`);
const dateOk = throws(() => toJSONSchema(z.object({ when: z.date() }), { io: 'input', unrepresentable: 'any' }));
check('unrepresentable:"any" turns the throw into a placeholder', null, dateOk);

// ------------------------------------------------- case 6: description carriage
check('field descriptions reach the wire', true, has(emitted, 'description'));

console.log(`\n${String(cases - failures.length)}/${String(cases)} expectations met`);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f.label}: expected ${JSON.stringify(f.expectation)}, got ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
