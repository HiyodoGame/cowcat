// P3 T3a — the trust gate (ADR-028).
//
// The asymmetry is the whole point: an untrusted workspace can still be refused and
// still be questioned, it cannot hand itself permissions. "Tightening never needs
// authorisation, loosening does."
//
// The cases that matter most are the two behavioural ones at the bottom. A gate that
// merely filtered the right array would still be wrong if it made ordinary work
// impossible, so the gate is judged by what `decide` does afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveConfig, trustedRules, type CowcatConfig, type Rule } from '../src/index.js';

const allow = (name: string, when: Rule['when'] = {}): Rule => ({ name, verdict: 'allow', when });
const deny = (name: string, when: Rule['when'] = {}): Rule => ({ name, verdict: 'deny', when });
const ask = (name: string, when: Rule['when'] = {}): Rule => ({ name, verdict: 'ask', when });

const config = (layers: Parameters<typeof resolveConfig>[0]): CowcatConfig => resolveConfig(layers);

const TRUSTED = { trusted: true };
const UNTRUSTED = { trusted: false };

const names = (rules: readonly Rule[]): readonly string[] => rules.map((r) => r.name);

// The rule under test in most of these: the workspace asks for something.
const WORKSPACE_ALLOWS_WRITE = config({ project: { rules: [allow('project-allow', { risk: 'write' })] } });

test('trusted: nothing is filtered', () => {
  const rules = trustedRules(WORKSPACE_ALLOWS_WRITE, TRUSTED);
  assert.deepEqual(names(rules), names(trustedRules(WORKSPACE_ALLOWS_WRITE, TRUSTED)));
  assert.ok(names(rules).includes('project-allow'));
});

test('untrusted: a project `allow` does not apply', () => {
  const rules = trustedRules(WORKSPACE_ALLOWS_WRITE, UNTRUSTED);
  assert.ok(!names(rules).includes('project-allow'));
});

test('untrusted: a project `deny` still applies', () => {
  const c = config({ project: { rules: [deny('project-deny', { path: '/repo/secrets' })] } });
  assert.ok(names(trustedRules(c, UNTRUSTED)).includes('project-deny'), 'tightening needs no authorisation');
});

test('untrusted: a project `ask` still applies', () => {
  const c = config({ project: { rules: [ask('project-ask', { risk: 'exec' })] } });
  assert.ok(names(trustedRules(c, UNTRUSTED)).includes('project-ask'));
});

test('untrusted: a project `deny` mixed with a project `allow` keeps only the deny', () => {
  const c = config({ project: { rules: [allow('pa', { risk: 'write' }), deny('pd', { risk: 'write' })] } });
  assert.deepEqual(names(trustedRules(c, UNTRUSTED)).filter((n) => n === 'pa' || n === 'pd'), ['pd']);
});

test('untrusted: a user-level `allow` still applies', () => {
  const c = config({ user: { rules: [allow('user-allow', { risk: 'write' })] } });
  assert.ok(names(trustedRules(c, UNTRUSTED)).includes('user-allow'), "the user's own machine-wide choice");
});

test('untrusted: a session-level `allow` still applies', () => {
  const c = config({ session: { rules: [allow('session-allow', { risk: 'write' })] } });
  assert.ok(names(trustedRules(c, UNTRUSTED)).includes('session-allow'), 'chosen explicitly for this run');
});

test('untrusted: the built-in baseline still applies', () => {
  // THE reason the gate is per-source rather than a blanket "no allow while
  // untrusted". A blanket filter would drop `reads-are-free` and make every file
  // read prompt — an agent nobody would run.
  const c = config({});
  assert.ok(names(trustedRules(c, UNTRUSTED)).includes('reads-are-free'));
});

test('untrusted: an ordinary read is still allowed, not asked about', () => {
  const rules = trustedRules(WORKSPACE_ALLOWS_WRITE, UNTRUSTED);
  const decision = decide({ kind: 'tool', callId: 'c1', name: 'Read', risk: 'read' }, rules);
  assert.equal(decision.verdict, 'allow', 'untrusted must not mean "ask about everything"');
});

test('untrusted: what the workspace allowed for itself becomes a question instead', () => {
  // The behavioural difference the gate exists to produce: the project said "writes
  // are fine here", and an untrusted session downgrades that to a prompt.
  const request = { kind: 'tool', callId: 'c1', name: 'Write', risk: 'write' } as const;
  assert.equal(decide(request, trustedRules(WORKSPACE_ALLOWS_WRITE, TRUSTED)).verdict, 'allow');
  const untrusted = decide(request, trustedRules(WORKSPACE_ALLOWS_WRITE, UNTRUSTED));
  assert.equal(untrusted.verdict, 'ask');
  assert.equal(untrusted.rule, 'no-rule-matched', 'it falls through to the default prompt, not to a silent deny');
});

test('untrusted: a project deny still reaches the decision, so the workspace can constrain itself', () => {
  const c = config({ project: { rules: [deny('no-here', { path: '/repo/secrets' })] } });
  const rules = trustedRules(c, UNTRUSTED);
  const decision = decide({ kind: 'tool', callId: 'c1', name: 'Read', risk: 'read', path: '/repo/secrets/k.pem' }, rules);
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'no-here');
});

test('the surviving rules keep their order, so the reported rule is stable', () => {
  const c = config({
    user: { rules: [allow('u1', { risk: 'write' })] },
    project: { rules: [allow('p1', { risk: 'write' }), deny('p2', { risk: 'write' })] },
    session: { rules: [allow('s1', { risk: 'write' })] },
  });
  const untrusted = names(trustedRules(c, UNTRUSTED));
  const trusted = names(trustedRules(c, TRUSTED));
  assert.deepEqual(untrusted, trusted.filter((n) => n !== 'p1'), 'only the project allow was removed');
});
