import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Session, defineTool, runTurn, type KernelEvent, type ToolGrant, type ToolPort } from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

const signal = new AbortController().signal;
const noGrant: ToolGrant = { networkApproved: false, unsandboxedApproved: false };

const asRecord = (value: unknown): Record<string, unknown> => {
  assert.ok(typeof value === 'object' && value !== null, 'expected an object schema');
  return value as Record<string, unknown>;
};

test('a definition derives the wire schema once, without $schema', () => {
  const reader = defineTool(
    {
      name: 'Read',
      description: 'read a file',
      risk: 'read',
      input: z.object({ file_path: z.string().describe('absolute path') }),
    },
    () => ({ ok: true, output: 'contents' }),
  );

  assert.deepEqual(reader.spec.inputSchema, {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'absolute path' } },
    required: ['file_path'],
  });
});

test('input mode keeps a defaulted field out of required, and the default on the wire', () => {
  // `io: 'input'` is the reason this is true; output mode would mark it required and
  // lose the "the model may omit it" half of the contract (ADR-047).
  const runner = defineTool(
    {
      name: 'Bash',
      description: 'run a command',
      risk: 'exec',
      input: z.object({ command: z.string(), timeout_ms: z.number().int().default(60_000) }),
    },
    () => ({ ok: true, output: '' }),
  );

  const schema = asRecord(runner.spec.inputSchema);
  assert.deepEqual(schema.required, ['command']);
  assert.equal(asRecord(asRecord(schema.properties).timeout_ms).default, 60_000);
});

test('the banned vocabulary is refused at definition time, with the offending path', () => {
  // Each entry is a construct ADR-047 forbids because the four targets disagree about
  // how to spell it — a union of objects becomes `anyOf`, primitives become a `type`
  // array, `record` becomes `propertyNames`, `literal` becomes `const`.
  const cases: readonly { readonly label: string; readonly input: z.ZodType; readonly expected: RegExp }[] = [
    {
      label: 'union of objects',
      input: z.object({ value: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) }),
      expected: /\.value\.anyOf: a union/,
    },
    {
      label: 'union of primitives',
      input: z.object({ value: z.union([z.string(), z.number()]) }),
      expected: /\.value\.type: a union or nullable/,
    },
    {
      label: 'nullable',
      input: z.object({ value: z.string().nullable() }),
      expected: /\.value\.type: a union or nullable/,
    },
    {
      label: 'record',
      input: z.object({ value: z.record(z.string(), z.string()) }),
      expected: /\.value\.propertyNames/,
    },
    {
      label: 'literal',
      input: z.object({ value: z.literal('x') }),
      expected: /\.value\.const/,
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () =>
        defineTool({ name: 'probe', description: entry.label, risk: 'read', input: entry.input }, () => ({
          ok: true,
          output: '',
        })),
      entry.expected,
      `${entry.label} should be refused`,
    );
  }
});

test('a non-object input schema is a declaration mistake', () => {
  assert.throws(
    () =>
      defineTool({ name: 'probe', description: 'x', risk: 'read', input: z.string() }, () => ({ ok: true, output: '' })),
    /must be an object/,
  );
});

test('a narrowable field the schema does not declare is refused', () => {
  // Otherwise every rule selecting on the path would silently miss, which is a policy
  // bypass that looks like a working configuration (ADR-027/047).
  assert.throws(
    () =>
      defineTool(
        {
          name: 'Read',
          description: 'read',
          risk: 'read',
          input: z.object({ path: z.string() }),
          pathInput: 'file_path',
        },
        () => ({ ok: true, output: '' }),
      ),
    /pathInput names "file_path"/,
  );
});

test('the declared fields reach the spec, so the kernel can build a request from them', () => {
  const tool = defineTool(
    {
      name: 'Read',
      description: 'read',
      risk: 'read',
      input: z.object({ file_path: z.string() }),
      pathInput: 'file_path',
    },
    () => ({ ok: true, output: '' }),
  );

  assert.equal(tool.spec.pathInput, 'file_path');
  assert.equal('commandInput' in tool.spec, false);
});

test('invalid arguments become a tool result naming the field, never a throw', async () => {
  let ran = false;
  const runner = defineTool(
    { name: 'Bash', description: 'run', risk: 'exec', input: z.object({ command: z.string() }) },
    () => {
      ran = true;
      return { ok: true, output: 'ran' };
    },
  );

  const result = await runner.run({ command: 42 }, signal, noGrant);

  assert.equal(result.ok, false);
  assert.match(result.output, /^invalid input for Bash:/);
  assert.match(result.output, /command: /);
  assert.equal(ran, false);
});

test('a valid call receives the parsed value, not the raw JSON', async () => {
  const seen: unknown[] = [];
  const tool = defineTool(
    { name: 'probe', description: 'x', risk: 'read', input: z.object({ limit: z.number().default(5) }) },
    (input) => {
      seen.push(input);
      return { ok: true, output: '' };
    },
  );

  const result = await tool.run({}, signal, noGrant);

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ limit: 5 }]);
});

test('the grant and the signal reach the implementation unchanged', async () => {
  const seen: { readonly signal: AbortSignal; readonly grant: ToolGrant }[] = [];
  const tool = defineTool({ name: 'probe', description: 'x', risk: 'exec', input: z.object({}) }, (_input, gotSignal, gotGrant) => {
    seen.push({ signal: gotSignal, grant: gotGrant });
    return { ok: true, output: '' };
  });

  const grant: ToolGrant = { networkApproved: true, unsandboxedApproved: false };
  await tool.run({}, signal, grant);

  assert.equal(seen.length, 1);
  const entry = seen[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.signal, signal);
  assert.deepEqual(entry.grant, grant);
});

test('a defineTool tool works end to end, and its path is logged canonically', async () => {
  // T1 put the canonical path in the log; T2 is what produces tools that carry one.
  const reader: ToolPort = defineTool(
    {
      name: 'Read',
      description: 'read',
      risk: 'read',
      input: z.object({ file_path: z.string() }),
      pathInput: 'file_path',
    },
    () => ({ ok: true, output: 'contents' }),
  );
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Read', input: { file_path: 'C:\\repo\\a.txt' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_tool_api');
  await runTurn(
    turnDeps(session, model, { tools: new Map([[reader.spec.name, reader]]) }),
    'read it',
    signal,
  );

  const finished = store.events.find((e: KernelEvent) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.equal(finished.path, 'C:/repo/a.txt');
  assert.deepEqual(session.state.readFiles, ['C:/repo/a.txt']);
});
