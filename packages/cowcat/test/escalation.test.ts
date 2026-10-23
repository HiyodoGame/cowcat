import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalKey,
  escalationStanding,
  initialState,
  normalizeSubject,
  parseEscalateInput,
  reduce,
  toolGrantKey,
  type ActionRequest,
} from '../src/index.js';

/**
 * ADR-129/130: Escalate input validation, the refused/escalation folds, and the grant
 * key rules (normalization, the `*` collision fix).
 */

function req(partial: Partial<ActionRequest> & { name: string }): ActionRequest {
  return { kind: 'tool', callId: 'c1', risk: 'exec', ...partial };
}

test('parseEscalateInput validates the appeal shape', () => {
  const ok = parseEscalateInput({ name: 'Bash', command: 'npm test', justification: 'need it' });
  assert.ok(ok.ok);
  assert.equal(ok.value.command, 'npm test');
  assert.equal(ok.value.withoutSandbox, false);
  const byPath = parseEscalateInput({ name: 'Write', path: '/tmp/x', justification: 'need it' });
  assert.ok(byPath.ok);

  const noSubject = parseEscalateInput({ name: 'Bash', justification: 'need it' });
  assert.ok(!noSubject.ok);
  assert.equal(noSubject.reason, 'subject');
  const both = parseEscalateInput({ name: 'Bash', command: 'a', path: '/p', justification: 'x' });
  assert.ok(!both.ok);
  assert.equal(both.reason, 'subject');
  const star = parseEscalateInput({ name: 'Bash', command: '*', justification: 'x' });
  assert.ok(!star.ok);
  assert.equal(star.reason, 'subject');
  const nul = parseEscalateInput({ name: 'Bash', command: 'a\u0000b', justification: 'x' });
  assert.ok(!nul.ok);
  assert.equal(nul.reason, 'subject');
  const noWhy = parseEscalateInput({ name: 'Bash', command: 'a', justification: '  ' });
  assert.ok(!noWhy.ok);
  assert.equal(noWhy.reason, 'justification');
  const long = parseEscalateInput({ name: 'Bash', command: 'a', justification: 'x'.repeat(501) });
  assert.ok(!long.ok);
  assert.equal(long.reason, 'justification');
  const sandboxFlag = parseEscalateInput({ name: 'Bash', command: 'a', justification: 'x', withoutSandbox: true });
  assert.ok(sandboxFlag.ok);
  assert.equal(sandboxFlag.value.withoutSandbox, true);
});

test('grants, refusals, and escalations fold from the answer events (ADR-129)', () => {
  let state = initialState('sess');
  state = reduce(state, {
    seq: 1, ts: 1, sessionId: 'sess', turnId: 't1', type: 'session.opened',
    schemaVersion: 1, cowcatVersion: '0', shell: { kind: 'posix', executable: '/bin/sh' },
  } as never);
  const answered = (verdict: 'once' | 'always' | 'session' | 'reject', by: 'user' | 'timeout') =>
    reduce(state, { seq: 2, ts: 2, sessionId: 'sess', turnId: 't1', type: 'approval.answered', callId: 'c', key: 'Bash\u0000npm test', verdict, by } as never);

  // A user's reject folds into `refused`; a timeout does not (nobody answered).
  state = answered('reject', 'user');
  assert.deepEqual(state.refused, ['Bash\u0000npm test']);
  state = initialState('sess');
  state = answered('reject', 'timeout');
  assert.deepEqual(state.refused, []);
  // Standing answers keep folding into `grants` as before.
  state = initialState('sess');
  state = answered('always', 'user');
  assert.deepEqual(state.grants, ['Bash\u0000npm test']);
});

test('escalationStanding: once burns on consumption, always stands (ADR-129 4)', () => {
  let state = initialState('sess');
  state = reduce(state, {
    seq: 2, ts: 2, sessionId: 'sess', turnId: 't1', type: 'escalation.granted',
    callId: 'c', key: 'Bash\u0000npm test', scope: 'once', dimension: 'deny-override',
  } as never);
  assert.equal(escalationStanding(state, 'Bash\u0000npm test', 'deny-override'), 'once');
  assert.equal(escalationStanding(state, 'Bash\u0000npm test', 'unsandboxed'), null, 'dimensions do not leak into each other');

  state = reduce(state, {
    seq: 3, ts: 3, sessionId: 'sess', turnId: 't1', type: 'escalation.consumed',
    callId: 'c', key: 'Bash\u0000npm test', dimension: 'deny-override',
  } as never);
  assert.equal(escalationStanding(state, 'Bash\u0000npm test', 'deny-override'), null, 'the once retry is spent');

  let always = initialState('sess');
  always = reduce(always, {
    seq: 2, ts: 2, sessionId: 'sess', turnId: 't1', type: 'escalation.granted',
    callId: 'c', key: 'Bash\u0000npm test', scope: 'always', dimension: 'deny-override',
  } as never);
  assert.equal(escalationStanding(always, 'Bash\u0000npm test', 'deny-override'), 'always');
});

test('approvalKey normalizes command whitespace; the tool grant cannot collide with a bare *', () => {
  assert.equal(normalizeSubject('  npm   test  '), 'npm test');
  assert.equal(approvalKey(req({ name: 'Bash', command: 'npm   test' })), approvalKey(req({ name: 'Bash', command: ' npm test ' })));
  assert.notEqual(approvalKey(req({ name: 'Bash', command: '*' })), toolGrantKey('Bash'), 'the P1-4 collision stays fixed');
  assert.equal(toolGrantKey('Bash'), 'Bash\u0000"*"');
});
