// P3 T5 — the audit consumer (ADR-033).
//
// What is being pinned is mostly about the failures, because the happy path is the
// easy part:
//   * a broken sink must not take the session down, and must not be silent either;
//   * "the tool reported no facts" and "nothing was applied" must stay different
//     facts, because an audit that conflates them cannot answer its own question;
//   * the consumer only reads the event stream, so it cannot influence a turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditConsumer,
  JsonlAuditSink,
  Session,
  runTurn,
  type AppliedSandbox,
  type AuditRecord,
  type ExecutionFacts,
  type TerminationRecord,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

const SANDBOX: AppliedSandbox = { mode: 'system', backend: 'bwrap', limitations: ['no seccomp'] };
const TERMINATION: TerminationRecord = {
  requested: false,
  reason: 'none',
  strategy: 'none',
  escalated: false,
  fallbackUsed: false,
  residuePossible: false,
};
const FACTS: ExecutionFacts = { sandbox: SANDBOX, termination: TERMINATION, removedEnv: ['API_KEY'], ignoredDeny: [] };

class CollectingSink {
  readonly records: AuditRecord[] = [];
  failNext = false;

  async write(record: AuditRecord): Promise<void> {
    if (this.failNext) throw new Error('disk on fire');
    this.records.push(record);
  }
}

// Structurally the shape the consumer reads. Declared here rather than imported so
// the test says out loud what the consumer is allowed to look at.
interface TestEvent {
  readonly type: string;
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly callId?: string;
  readonly name?: string;
  readonly decision?: { readonly verdict: 'allow' | 'ask' | 'deny'; readonly rule: string; readonly reason?: string | null };
  readonly verdict?: 'once' | 'always' | 'reject';
  readonly by?: 'user' | 'policy' | 'timeout';
  readonly key?: string;
  readonly ok?: boolean;
  readonly output?: string;
  readonly facts?: ExecutionFacts | null;
}

const event = (over: Partial<TestEvent> & Pick<TestEvent, 'type' | 'seq'>): TestEvent => ({
  ts: over.seq,
  sessionId: 's',
  turnId: 't',
  ...over,
});

const firstRecord = (sink: CollectingSink): AuditRecord => {
  const [record] = sink.records;
  assert.ok(record, 'expected at least one audit record');
  return record;
};

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

test('a decision, an approval and a result become one row', async () => {
  const sink = new CollectingSink();
  const consumer = new AuditConsumer(sink);

  consumer.accept(event({ type: 'policy.decided', seq: 1, callId: 'c1', decision: { verdict: 'ask', rule: 'no-rule-matched', reason: null } }));
  consumer.accept(event({ type: 'approval.answered', seq: 2, callId: 'c1', key: 'k', verdict: 'once', by: 'user' }));
  assert.equal(sink.records.length, 0, 'nothing is written until the call finishes');
  consumer.accept(event({ type: 'tool.finished', seq: 3, callId: 'c1', name: 'Bash', ok: true, output: 'ok', facts: FACTS }));

  const summary = await consumer.close();
  assert.equal(summary.written, 1);
  const [record] = sink.records;
  assert.ok(record);
  assert.equal(record.callId, 'c1');
  assert.equal(record.tool, 'Bash');
  assert.equal(record.verdict, 'ask');
  assert.equal(record.rule, 'no-rule-matched');
  assert.deepEqual(record.approval, { verdict: 'once', by: 'user' });
  assert.equal(record.ok, true);
  assert.deepEqual(record.sandbox, SANDBOX);
  assert.deepEqual(record.removedEnv, ['API_KEY']);
});

test('a call that was never asked about still produces a row', async () => {
  const sink = new CollectingSink();
  const consumer = new AuditConsumer(sink);
  consumer.accept(event({ type: 'policy.decided', seq: 1, callId: 'c1', decision: { verdict: 'allow', rule: 'reads-are-free', reason: null } }));
  consumer.accept(event({ type: 'tool.finished', seq: 2, callId: 'c1', name: 'Read', ok: true, output: 'x', facts: null }));
  await consumer.close();

  assert.equal(firstRecord(sink).approval, null);
  assert.equal(firstRecord(sink).verdict, 'allow');
});

test('"the tool reported nothing" is not "no sandbox was applied"', async () => {
  // The distinction the whole consumer exists for. A row that said `mode: 'off'` for a
  // tool that simply did not speak would be an audit asserting something it does not
  // know.
  const sink = new CollectingSink();
  const consumer = new AuditConsumer(sink);
  consumer.accept(event({ type: 'policy.decided', seq: 1, callId: 'c1', decision: { verdict: 'allow', rule: 'r', reason: null } }));
  consumer.accept(event({ type: 'tool.finished', seq: 2, callId: 'c1', name: 'Read', ok: true, output: 'x', facts: null }));
  await consumer.close();

  assert.equal(firstRecord(sink).sandbox, null, 'not reported, not `off`');
  assert.equal(firstRecord(sink).termination, null);
  assert.deepEqual(firstRecord(sink).removedEnv, []);
});

test('an event stream that starts mid-call invents no verdict', async () => {
  const sink = new CollectingSink();
  const consumer = new AuditConsumer(sink);
  consumer.accept(event({ type: 'tool.finished', seq: 1, callId: 'orphan', name: 'Bash', ok: true, output: 'x', facts: null }));
  const summary = await consumer.close();
  assert.equal(summary.written, 0, 'there was no decision to report, and making one up is worse than silence');
});

test('ephemeral deltas and unrelated events are ignored', async () => {
  const sink = new CollectingSink();
  const consumer = new AuditConsumer(sink);
  consumer.accept(event({ type: 'model.delta', seq: 0, turnId: 't', text: 'hello' } as never));
  consumer.accept(event({ type: 'turn.transitioned', seq: 1, from: 'idle', to: 'requesting', reason: null } as never));
  consumer.accept(event({ type: 'model.message', seq: 2, text: 'x', toolCalls: [] } as never));
  assert.equal((await consumer.close()).written, 0);
});

// ---------------------------------------------------------------------------
// A broken sink
// ---------------------------------------------------------------------------

test('a failing sink does not throw out of accept', async () => {
  const sink = new CollectingSink();
  sink.failNext = true;
  const consumer = new AuditConsumer(sink);

  assert.doesNotThrow(() => {
    consumer.accept(event({ type: 'policy.decided', seq: 1, callId: 'c1', decision: { verdict: 'allow', rule: 'r', reason: null } }));
    consumer.accept(event({ type: 'tool.finished', seq: 2, callId: 'c1', name: 'T', ok: true, output: '', facts: null }));
  });
});

test('a failing sink is counted, not swallowed', async () => {
  // An audit that fails silently is worse than no audit: it looks like evidence.
  const sink = new CollectingSink();
  sink.failNext = true;
  const consumer = new AuditConsumer(sink);
  consumer.accept(event({ type: 'policy.decided', seq: 1, callId: 'c1', decision: { verdict: 'allow', rule: 'r', reason: null } }));
  consumer.accept(event({ type: 'tool.finished', seq: 2, callId: 'c1', name: 'T', ok: true, output: '', facts: null }));

  const summary = await consumer.close();
  assert.equal(summary.written, 0);
  assert.equal(summary.failed, 1);
  assert.match(summary.lastFailure ?? '', /disk on fire/);
});

test('the second write still happens after the first failed', async () => {
  const sink = new CollectingSink();
  sink.failNext = true;
  const consumer = new AuditConsumer(sink);
  const call = (seq: number, id: string): void => {
    consumer.accept(event({ type: 'policy.decided', seq, callId: id, decision: { verdict: 'allow', rule: 'r', reason: null } }));
    consumer.accept(event({ type: 'tool.finished', seq: seq + 1, callId: id, name: 'T', ok: true, output: '', facts: null }));
  };
  call(1, 'c1');
  sink.failNext = false;
  call(3, 'c2');

  const summary = await consumer.close();
  assert.equal(summary.written, 1);
  assert.equal(summary.failed, 1);
  assert.equal(firstRecord(sink).callId, 'c2');
});

test('close() waits for writes still in flight', async () => {
  // Without this a session-end report could claim zero failures while a write was
  // still failing.
  let release: (() => void) | undefined;
  const slow = {
    async write(): Promise<void> {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('too late');
    },
  };
  const consumer = new AuditConsumer(slow);
  consumer.accept(event({ type: 'policy.decided', seq: 1, callId: 'c1', decision: { verdict: 'allow', rule: 'r', reason: null } }));
  consumer.accept(event({ type: 'tool.finished', seq: 2, callId: 'c1', name: 'T', ok: true, output: '', facts: null }));

  assert.equal(consumer.summary().inFlight, 1, 'the write is still open');
  const closing = consumer.close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  release?.();
  const summary = await closing;
  assert.equal(summary.failed, 1, 'close() saw the failure that summary() had not yet');
});

// ---------------------------------------------------------------------------
// End to end: a real turn, a real subscriber, a real file
// ---------------------------------------------------------------------------

test('the kernel passes a tool\'s execution facts into the log', async () => {
  const reporting = tool({ name: 'sh', description: 'run', risk: 'exec' }, () => ({ ok: true, output: 'ran', facts: FACTS }));
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_facts');
  await runTurn(
    turnDeps(session, new ScriptedModel([
      [{ type: 'tool_call', call: { callId: 'c1', name: 'sh', input: {} } }],
      [{ type: 'text', text: 'done' }],
    ]), { tools: new Map([['sh', reporting]]) }),
    'go',
    new AbortController().signal,
  );

  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.equal(finished.name, 'sh', 'the audit needs the tool name, and the event now carries it');
  assert.deepEqual(finished.facts, FACTS);
});

test('a subscriber sees facts, and the audit row lands on disk as one JSON line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cowcat-audit-'));
  try {
    const file = join(root, 'nested', 'audit.jsonl');
    const consumer = new AuditConsumer(new JsonlAuditSink({ file }));
    const reporting = tool({ name: 'sh', description: 'run', risk: 'exec' }, () => ({ ok: true, output: 'ran', facts: FACTS }));
    const store = new MemoryEventStore();
    const session = await Session.create(sessionDeps(store), 'sess_disk');
    // Exactly how a real front end would wire it: subscribe and forget.
    const unsubscribe = session.subscribe((update) => {
      consumer.accept(update as never);
    });

    await runTurn(
      turnDeps(session, new ScriptedModel([
        [{ type: 'tool_call', call: { callId: 'c1', name: 'sh', input: {} } }],
        [{ type: 'text', text: 'done' }],
      ]), { tools: new Map([['sh', reporting]]) }),
      'go',
      new AbortController().signal,
    );
    unsubscribe();

    const summary = await consumer.close();
    assert.equal(summary.written, 1);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? '{}') as AuditRecord;
    assert.equal(record.tool, 'sh');
    assert.deepEqual(record.sandbox, SANDBOX);
    assert.equal(record.sessionId, 'sess_disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sink creates its directory and appends rather than overwrites', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cowcat-audit-'));
  try {
    const file = join(root, 'deep', 'audit.jsonl');
    const sink = new JsonlAuditSink({ file });
    const record: AuditRecord = {
      sessionId: 's',
      turnId: null,
      seq: 1,
      ts: 1,
      callId: 'c1',
      tool: 'T',
      verdict: 'allow',
      rule: 'r',
      approval: null,
      ok: true,
      sandbox: null,
      termination: null,
      removedEnv: [],
      ignoredDeny: [],
    };
    await sink.write(record);
    await sink.write({ ...record, callId: 'c2' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'a trail a later run can truncate is not a trail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
