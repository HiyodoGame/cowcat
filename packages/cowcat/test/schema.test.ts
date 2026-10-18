import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { describeIssues, kernelEventSchema, sessionSnapshotSchema } from '../src/adapters/schema.js';
import { SCHEMA_VERSION, makeAttachment, type KernelEvent, type SessionSnapshot } from '../src/index.js';

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
  name: 'Read',
  ok: true,
  output: 'done',
  facts: null,
  truncation: { truncated: true, dropped: 12, reason: 'read: 2000 lines' },
  path: '/repo/a.txt',
  // Both kinds of reference, so the round-trip below covers the optional metadata as
  // well as the required fields (ADR-057).
  attachments: [
    makeAttachment({ type: 'image', mediaType: 'image/png', path: '/repo/a.png', bytes: 12, width: 4, height: 3 }),
    makeAttachment({ type: 'document', mediaType: 'application/pdf', path: '/repo/a.pdf', bytes: 4096, pages: 2 }),
  ],
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

test('truncation and path survive a JSON round trip', () => {
  // The store writes JSON lines, so the contract has to hold for the decoded values, not
  // just for the in-memory object (ADR-048/049).
  const result = kernelEventSchema.safeParse(JSON.parse(JSON.stringify(toolFinished)) as unknown);
  if (!result.success) assert.fail(describeIssues(result.error));

  if (result.data.type !== 'tool.finished') assert.fail('expected a tool.finished event');
  assert.deepEqual(result.data.truncation, { truncated: true, dropped: 12, reason: 'read: 2000 lines' });
  assert.equal(result.data.path, '/repo/a.txt');
});

test('a tool.finished logged before those fields existed decodes with null', () => {
  // Local logs predate the fields (schemaVersion 1 was never published, ADR-019). "The
  // key is absent" and "the tool reported nothing" have to mean the same thing here, or
  // an old session becomes unreadable for a field it could not have written.
  const older: Record<string, unknown> = { ...toolFinished };
  delete older.truncation;
  delete older.path;

  const result = kernelEventSchema.safeParse(older);
  if (!result.success) assert.fail(describeIssues(result.error));

  if (result.data.type !== 'tool.finished') assert.fail('expected a tool.finished event');
  assert.equal(result.data.truncation, null);
  assert.equal(result.data.path, null);
});

test('a todo.updated event survives a JSON round trip with its statuses', () => {
  const event: KernelEvent = {
    seq: 10,
    ts: 10,
    sessionId: 'sess',
    turnId: 'turn_1',
    type: 'todo.updated',
    todos: [
      { content: 'Add input validation', status: 'in_progress', activeForm: 'Adding input validation' },
      { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
    ],
  };

  const result = kernelEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
  if (!result.success) assert.fail(describeIssues(result.error));
  if (result.data.type !== 'todo.updated') assert.fail('expected a todo.updated event');
  assert.deepEqual(result.data.todos, event.todos);

  // A status the kernel cannot interpret must not reach the log (ADR-054).
  const bogus = { ...event, todos: [{ content: 'x', status: 'done', activeForm: 'x' }] };
  assert.equal(kernelEventSchema.safeParse(bogus).success, false);
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
