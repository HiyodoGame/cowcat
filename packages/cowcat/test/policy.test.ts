import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_RULES, type ActionRequest, type Rule } from '../src/index.js';

const req = (risk: ActionRequest['risk']): ActionRequest => ({ kind: 'tool', callId: 'c1', name: 't', risk });

test('reads are allowed and mutations are asked about by default', () => {
  assert.equal(decide(req('read'), DEFAULT_RULES).verdict, 'allow');
  for (const risk of ['write', 'exec', 'network'] as const) {
    assert.equal(decide(req(risk), DEFAULT_RULES).verdict, 'ask', risk);
  }
});

test('an action no rule covers is asked, never allowed', () => {
  const decision = decide(req('read'), []);
  assert.equal(decision.verdict, 'ask');
  assert.equal(decision.rule, 'no-rule-matched');
});

test('deny beats ask, and ask beats allow, regardless of rule order', () => {
  const allow: Rule = { name: 'a', matches: () => true, verdict: 'allow' };
  const ask: Rule = { name: 'b', matches: () => true, verdict: 'ask' };
  const deny: Rule = { name: 'c', matches: () => true, verdict: 'deny', reason: 'blocked' };
  const decision = decide(req('write'), [allow, ask, deny]);
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'c');
  assert.equal(decision.reason, 'blocked');
  assert.equal(decide(req('write'), [allow, ask]).verdict, 'ask');
});

test('within one verdict the first matching rule is the one reported', () => {
  const first: Rule = { name: 'first', matches: () => true, verdict: 'allow' };
  const second: Rule = { name: 'second', matches: () => true, verdict: 'allow' };
  assert.equal(decide(req('read'), [first, second]).rule, 'first');
});
