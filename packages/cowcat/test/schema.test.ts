import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { describeIssues, kernelEventSchema, sessionSnapshotSchema } from '../src/adapters/schema.js';
import { SCHEMA_VERSION, type KernelEvent, type SessionSnapshot } from '../src/index.js';

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The kernel's event union and this schema are two hand-written descriptions of one
// format. Drift between them must fail the build here, not surface later as a
// "corrupt log" on a log the kernel itself wrote.
const schemaMatchesKernel: Equals<z.infer<typeof kernelEventSchema>, KernelEvent> = true;

// Same protection for the snapshot: it is derived data, but a half-understood state
// would be silently wrong rather than merely slow.
const snapshotMatchesPort: Equals<z.infer<typeof sessionSnapshotSchema>, SessionSnapshot> = true;

const header: KernelEvent = {
  seq: 1,
  ts: 1,
  sessionId: 'sess',
  turnId: null,
  type: 'session.opened',
  schemaVersion: SCHEMA_VERSION,
  cowcatVersion: '0.0.0-test',
  shell: { kind: 'posix', executable: '/bin/sh' },
};
const turnOpened: KernelEvent = {
  seq: 2,
  ts: 2,
  sessionId: 'sess',
  turnId: 'turn_1',
  type: 'turn.opened',
  input: 'hi',
};
const turnTransitioned: KernelEvent = {
  seq: 3,
  ts: 3,
  sessionId: 'sess',
  turnId: 'turn_1',
  type: 'turn.transitioned',
  from: 'idle',
  to: 'requesting',
  reason: null,
};
const modelMessage: KernelEvent = {
  seq: 4,
  ts: 4,
  sessionId: 'sess',
  turnId: 'turn_1',
  type: 'model.message',
  text: 'hello',
  toolCalls: [{ callId: 'c1', name: 'read_file', input: { path: 'a' } }],
  // Both arms of the reasoning union, because each one is a separate decode rule and
  // only one of them has readable text (ADR-045).
  reasoning: [
    { type: 'thinking', text: 'the file is a test fixture', signature: 'sig-opaque-1' },
    { type: 'redacted', data: 'encrypted-blob' },
  ],
  stopReason: { kind: 'toolCalls', raw: 'tool_calls' },
};
const modelUsage: KernelEvent = {
  seq: 9,
  ts: 9,
  sessionId: 'sess',
  turnId: 'turn_1',
  type: 'model.usage',
  usage: { input: 10, output: 4, cacheRead: 0, cacheCreation: 0 },
};
const policyDecided: KernelEvent = {
  seq: 5,
  ts: 5,
  sessionId: 'sess',
  turnId: 'turn_1',
  type: 'policy.decided',
  callId: 'c1',
  decision: { verdict: 'allow', rule: 'reads are allowed', reason: null },
};
const toolFinished: KernelEvent = {
  seq: 8,
  ts: 8,
  sessionId: 'sess',
  turnId: 'turn_1',
  type: 'tool.finished',
  callId: 'c1',
  name: 'echo_file',
  ok: true,
  output: 'done',
  facts: null,
};

const everyEvent: readonly KernelEvent[] = [
  header,
  turnOpened,
  turnTransitioned,
  modelMessage,
  modelUsage,
  policyDecided,
  toolFinished,
];

test('the schema and the kernel event union are the same type', () => {
  assert.equal(schemaMatchesKernel, true);
});

test('the snapshot schema and the SnapshotPort type are the same type', () => {
  assert.equal(snapshotMatchesPort, true);
});

test('every event the kernel writes decodes', () => {
  for (const event of everyEvent) {
    const result = kernelEventSchema.safeParse(event);
    if (!result.success) assert.fail(`${event.type} was rejected: ${describeIssues(result.error)}`);
  }
});

test('a line from a newer build still decodes, with unknown keys stripped', () => {
  const result = kernelEventSchema.safeParse({ ...header, fieldFromTheFuture: true });
  if (!result.success) assert.fail(describeIssues(result.error));

  assert.equal('fieldFromTheFuture' in result.data, false);
});

test('an unknown schema version decodes structurally and is left to the kernel', () => {
  // Judging the version is the kernel's job (ADR-012). The schema must not turn it
  // into "field mismatch", which points at the wrong cause.
  const result = kernelEventSchema.safeParse({ ...header, schemaVersion: 99 });
  if (!result.success) assert.fail(describeIssues(result.error));

  assert.equal(result.data.type === 'session.opened' ? result.data.schemaVersion : null, 99);
});

test('a corrupt field is reported with its path', () => {
  const result = kernelEventSchema.safeParse({ ...header, seq: 'one' });
  if (result.success) assert.fail('expected a decode failure');

  assert.match(describeIssues(result.error), /^seq: /);
});

test('a nested field is reported with its index', () => {
  const result = kernelEventSchema.safeParse({
    ...modelMessage,
    toolCalls: [{ callId: 7, name: 'read_file', input: null }],
  });
  if (result.success) assert.fail('expected a decode failure');

  assert.match(describeIssues(result.error), /toolCalls\[0\]\.callId/);
});

test('a malformed reasoning block is reported with its path', () => {
  // Both arms are closed shapes at the boundary, and each one is its own decode rule: a
  // thinking block without its opaque signature and a redacted block without its payload
  // are both unreplayable, so accepting either would push the failure to the wire
  // (ADR-045).
  const malformed: readonly Record<string, unknown>[] = [
    { type: 'thinking', text: 'no signature' },
    { type: 'redacted' },
  ];
  for (const block of malformed) {
    const result = kernelEventSchema.safeParse({ ...modelMessage, reasoning: [block] });
    if (result.success) assert.fail(`expected ${JSON.stringify(block)} to be refused`);

    assert.match(describeIssues(result.error), /reasoning\[0\]/);
  }
});

test('an event type the kernel does not know is refused', () => {
  const result = kernelEventSchema.safeParse({ ...header, type: 'from.the.future' });
  if (result.success) assert.fail('expected a decode failure');

  assert.match(describeIssues(result.error), /^type: /);
});
