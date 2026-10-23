// P3 T4 — the approval protocol (ADR-031, ADR-032).
//
// Three things are being pinned, and all three are about a log being readable
// afterwards rather than about the happy path:
//
//   * an approval leaves a question AND an answer in the log, so a turn that ends
//     inside one says what it was waiting for;
//   * a timeout is a recorded refusal, not a hang and not an error;
//   * `always` is a fact derived from the log, so a reopened session gets its grants
//     back — and it is scoped to exactly the action that was approved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  approvalKey,
  replay,
  runTurn,
  type ActionRequest,
  type ApprovalVerdict,
  type KernelEvent,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

const writer = (name = 'write_file'): ToolPort =>
  tool({ name, description: 'write', risk: 'write' }, () => ({ ok: true, output: 'written' }));

const modelFor = (call: { callId: string; name: string; input: unknown }): ScriptedModel =>
  new ScriptedModel([
    [{ type: 'tool_call', call }],
    [{ type: 'text', text: 'done' }],
  ]);

async function runOnce(options: {
  readonly tools?: readonly ToolPort[];
  readonly call?: { callId: string; name: string; input: unknown };
  readonly approve: (request: ActionRequest) => Promise<ApprovalVerdict>;
  readonly approvalTimeoutMs?: number;
  readonly sessionId?: string;
}) {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), options.sessionId ?? 'sess_approval');
  const outcome = await runTurn(
    turnDeps(session, modelFor(options.call ?? { callId: 'c1', name: 'write_file', input: { file_path: '/repo/a.txt' } }), {
      tools: new Map((options.tools ?? [writer()]).map((t) => [t.spec.name, t])),
      approve: (request) => options.approve(request),
      ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
    }),
    'go',
    new AbortController().signal,
  );
  return { store, session, outcome, types: (): string[] => store.events.map((e) => e.type) };
}

const answered = (events: readonly KernelEvent[]): Extract<KernelEvent, { type: 'approval.answered' }> | undefined =>
  events.find((e): e is Extract<KernelEvent, { type: 'approval.answered' }> => e.type === 'approval.answered');

// ---------------------------------------------------------------------------
// The question and the answer are both in the log
// ---------------------------------------------------------------------------

test('an ask writes a question and an answer around it', async () => {
  const { types, store } = await runOnce({ approve: async () => 'once' });
  const log = types();
  const asked = log.indexOf('approval.requested');
  const told = log.indexOf('approval.answered');
  assert.ok(asked !== -1 && told !== -1);
  assert.equal(asked < told, true, 'the question comes first');
  assert.equal(log.indexOf('policy.decided') < asked, true, 'and the decision that prompted it comes first of all');
  assert.equal(told < log.indexOf('tool.finished'), true, 'the answer precedes the result it allowed');
  assert.equal(answered(store.events)?.verdict, 'once');
  assert.equal(answered(store.events)?.by, 'user');
});

test('the question carries what the card needs', async () => {
  const { store } = await runOnce({ approve: async () => 'once' });
  const requested = store.events.find((e) => e.type === 'approval.requested');
  assert.ok(requested?.type === 'approval.requested');
  assert.equal(requested.name, 'write_file');
  assert.equal(requested.rule, 'no-rule-matched', 'the default prompt is the fallback (ADR-034)');
  assert.equal(requested.callId, 'c1');
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a rejection stops the tool and says the user said no', async () => {
  let ran = false;
  const guarded = tool({ name: 'write_file', description: 'w', risk: 'write' }, () => {
    ran = true;
    return { ok: true, output: '' };
  });
  const { session, store } = await runOnce({ tools: [guarded], approve: async () => 'reject' });

  assert.equal(ran, false);
  assert.equal(answered(store.events)?.verdict, 'reject');
  const result = session.state.messages.find((m) => m.role === 'tool');
  assert.equal(result?.output, 'rejected by user');
});

test('a timeout is a recorded refusal, not a hang', async () => {
  let ran = false;
  const guarded = tool({ name: 'write_file', description: 'w', risk: 'write' }, () => {
    ran = true;
    return { ok: true, output: '' };
  });
  // Never answers.
  const { session, store, outcome } = await runOnce({
    tools: [guarded],
    approve: () => new Promise<ApprovalVerdict>(() => {}),
    approvalTimeoutMs: 10,
  });

  assert.equal(ran, false, 'unattended work ends in a refusal, not in a granted call');
  assert.equal(outcome.state, 'completed', 'the turn itself finished cleanly');
  const answer = answered(store.events);
  assert.ok(answer, 'the log must carry an answer');
  assert.equal(answer.verdict, 'reject');
  assert.equal(answer.by, 'timeout', 'and the log says WHY nobody answered');
  const result = session.state.messages.find((m) => m.role === 'tool');
  assert.match(String(result?.output), /timeout/);
  assert.notEqual(result?.output, 'rejected by user', 'a timeout is not the same fact as a person saying no');
});

test('aborting while a question is open cancels the turn instead of waiting', async () => {
  // The legacy implementation awaited the approval with no regard for the signal, so
  // a cancelled session sat on the question until someone answered it.
  const controller = new AbortController();
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_abort');
  const deps = turnDeps(session, modelFor({ callId: 'c1', name: 'write_file', input: {} }), {
    tools: new Map([['write_file', writer()]]),
    approve: () => new Promise<ApprovalVerdict>(() => {}),
    approvalTimeoutMs: 60_000,
  });

  const running = runTurn(deps, 'go', controller.signal);
  // Let the turn reach the open question, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();

  const outcome = await running;
  assert.equal(outcome.state, 'cancelled');
});

// ---------------------------------------------------------------------------
// `always` is scoped to the session, and to the action
// ---------------------------------------------------------------------------

test('an `always` lets a later identical call through without asking', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_always');
  const call = { callId: 'c1', name: 'write_file', input: { file_path: '/repo/a.txt' } };
  const asked: string[] = [];

  const first = turnDeps(session, modelFor(call), {
    tools: new Map([['write_file', writer()]]),
    approve: async (request) => {
      asked.push(request.callId);
      return 'always';
    },
  });
  await runTurn(first, 'go', new AbortController().signal);

  const secondCall = { callId: 'c2', name: 'write_file', input: { file_path: '/repo/a.txt' } };
  const second = turnDeps(session, modelFor(secondCall), {
    tools: new Map([['write_file', writer()]]),
    approve: async (request) => {
      asked.push(request.callId);
      return 'reject';
    },
  });
  await runTurn(second, 'go', new AbortController().signal);

  assert.deepEqual(asked, ['c1'], 'the second call was not put to the user');
  // And the log still says why it ran: an `ask` followed by nothing is what an
  // auditor would read as the kernel ignoring its own decision.
  const answers = store.events.filter((e) => e.type === 'approval.answered');
  assert.equal(answers.length, 2);
  const secondAnswer = answers[1];
  assert.ok(secondAnswer?.type === 'approval.answered');
  assert.equal(secondAnswer.by, 'policy');
  assert.equal(secondAnswer.verdict, 'always');
});

test('an `always` does NOT cover a different command', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_always_diff');
  const asked: string[] = [];
  const approver = async (request: ActionRequest): Promise<ApprovalVerdict> => {
    asked.push(request.callId);
    return asked.length === 1 ? 'always' : 'reject';
  };

  await runTurn(
    turnDeps(session, modelFor({ callId: 'c1', name: 'write_file', input: { file_path: '/repo/a.txt' } }), {
      tools: new Map([['write_file', writer()]]),
      approve: approver,
    }),
    'go',
    new AbortController().signal,
  );
  await runTurn(
    turnDeps(session, modelFor({ callId: 'c2', name: 'write_file', input: { file_path: '/repo/b.txt' } }), {
      tools: new Map([['write_file', writer()]]),
      approve: approver,
    }),
    'go',
    new AbortController().signal,
  );

  assert.deepEqual(asked, ['c1', 'c2'], 'a different path is a different action');
});

test('a `session` answer covers the whole tool for the rest of the session', async () => {
  // ADR-094: the coarse grant exists as its own answer, so `always` keeps its exact
  // meaning. A different command under the same tool is exactly the case measured in
  // the beta session (36 Bash calls, 11 `always` answers, 0 reuses).
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_session_grant');
  const asked: string[] = [];
  const approver = async (request: ActionRequest): Promise<ApprovalVerdict> => {
    asked.push(request.callId);
    return asked.length === 1 ? 'session' : 'reject';
  };

  await runTurn(
    turnDeps(session, modelFor({ callId: 'c1', name: 'write_file', input: { file_path: '/repo/a.txt' } }), {
      tools: new Map([['write_file', writer()]]),
      approve: approver,
    }),
    'go',
    new AbortController().signal,
  );
  await runTurn(
    turnDeps(session, modelFor({ callId: 'c2', name: 'write_file', input: { file_path: '/repo/b.txt' } }), {
      tools: new Map([['write_file', writer()]]),
      approve: approver,
    }),
    'go',
    new AbortController().signal,
  );

  assert.deepEqual(asked, ['c1'], 'the second call used the session grant');
  const answers = store.events.filter((event) => event.type === 'approval.answered');
  const second = answers[1];
  assert.ok(second !== undefined);
  assert.equal(second.by, 'policy');
  assert.equal(second.verdict, 'session');
  // The grant is tool-level, not action-level: that is what makes it reusable. The
  // subject is quoted since ADR-129 (review P1-4): a bare `*` is a real command, and
  // the old spelling collided with it.
  assert.equal(second.key, 'write_file\u0000"*"');
});

test('grants come back when the session is replayed', async () => {
  // The property the whole design turns on: a grant is derived from the log, so
  // "replaying reproduces the live session" holds for approvals too.
  const { store, session } = await runOnce({ approve: async () => 'always' });
  const reopened = replay('sess_approval', store.events);
  assert.deepEqual(reopened.grants, session.state.grants);
  assert.equal(reopened.grants.length, 1);
});

// ---------------------------------------------------------------------------
// approvalKey
// ---------------------------------------------------------------------------

test('approvalKey keys a command by the command', () => {
  const base: ActionRequest = { kind: 'tool', callId: 'c', name: 'Bash', risk: 'exec' };
  assert.notEqual(approvalKey({ ...base, command: 'npm test' }), approvalKey({ ...base, command: 'npm run build' }));
  assert.equal(approvalKey({ ...base, command: 'npm test' }), approvalKey({ ...base, callId: 'other', command: 'npm test' }));
});

test('approvalKey keys a file tool by the path', () => {
  const base: ActionRequest = { kind: 'tool', callId: 'c', name: 'Write', risk: 'write' };
  assert.notEqual(approvalKey({ ...base, path: '/a' }), approvalKey({ ...base, path: '/b' }));
});

test('approvalKey falls back to the whole input when there is neither', () => {
  const base: ActionRequest = { kind: 'tool', callId: 'c', name: 'Other', risk: 'write' };
  assert.notEqual(approvalKey({ ...base, input: { a: 1 } }), approvalKey({ ...base, input: { a: 2 } }));
});

test('approvalKey does not confuse two tools with the same subject', () => {
  const a: ActionRequest = { kind: 'tool', callId: 'c', name: 'Write', risk: 'write', path: '/x' };
  const b: ActionRequest = { kind: 'tool', callId: 'c', name: 'Delete', risk: 'write', path: '/x' };
  assert.notEqual(approvalKey(a), approvalKey(b));
});
