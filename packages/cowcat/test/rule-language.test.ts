// The structured rule language (ADR-027). These cases pin the matcher's semantics
// rather than the defaults: what a rule means when it narrows on tool / risk /
// path / command, and — more importantly — where it must NOT match.
//
// The two failure modes worth guarding are both fail-OPEN, so neither shows up as
// a crash:
//   * a path rule matching a sibling by string prefix (`/a/b` catching `/a/bc`);
//   * a rule that narrows on a field the request does not carry, matching anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, validateRules, type ActionRequest, type Rule } from '../src/index.js';

const req = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  kind: 'tool',
  callId: 'c1',
  name: 't',
  risk: 'write',
  ...over,
});

const rule = (when: Rule['when'], verdict: Rule['verdict'] = 'allow'): Rule => ({
  name: 'r',
  when,
  verdict,
});

const verdictFor = (when: Rule['when'], request: ActionRequest): string => decide(request, [rule(when)]).verdict;

const problemsFor = (rules: readonly Rule[]): readonly string[] => validateRules(rules).map((p) => p.problem);

const firstProblem = (rules: readonly Rule[]): string => {
  const [problem] = validateRules(rules);
  assert.ok(problem, 'expected at least one problem');
  return problem.problem;
};

// ---------------------------------------------------------------------------
// when: {} — the old `matches: () => true`
// ---------------------------------------------------------------------------

test('an empty `when` matches every action', () => {
  for (const risk of ['read', 'write', 'exec', 'network'] as const) {
    assert.equal(verdictFor({}, req({ risk })), 'allow', risk);
  }
});

// ---------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------

test('`when.tool` as a string matches only that tool name', () => {
  assert.equal(verdictFor({ tool: 'Bash' }, req({ name: 'Bash' })), 'allow');
  assert.equal(verdictFor({ tool: 'Bash' }, req({ name: 'bash' })), 'ask', 'tool names are case-sensitive');
  assert.equal(verdictFor({ tool: 'Bash' }, req({ name: 'BashExtra' })), 'ask', 'no prefix matching on names');
});

test('`when.tool` as an array matches any member', () => {
  const when = { tool: ['Read', 'Glob'] };
  assert.equal(verdictFor(when, req({ name: 'Read' })), 'allow');
  assert.equal(verdictFor(when, req({ name: 'Glob' })), 'allow');
  assert.equal(verdictFor(when, req({ name: 'Write' })), 'ask');
});

test('a bare `*` matches every tool', () => {
  assert.equal(verdictFor({ tool: '*' }, req({ name: 'anything at all' })), 'allow');
});

// ---------------------------------------------------------------------------
// risk
// ---------------------------------------------------------------------------

test('`when.risk` accepts one value or several', () => {
  assert.equal(verdictFor({ risk: 'read' }, req({ risk: 'read' })), 'allow');
  assert.equal(verdictFor({ risk: 'read' }, req({ risk: 'write' })), 'ask');
  assert.equal(verdictFor({ risk: ['write', 'exec', 'network'] }, req({ risk: 'network' })), 'allow');
});

// ---------------------------------------------------------------------------
// path — literal or directory prefix, on canonical absolute paths
// ---------------------------------------------------------------------------

test('`when.path` matches the exact path', () => {
  assert.equal(verdictFor({ path: '/repo/src' }, req({ path: '/repo/src' })), 'allow');
});

test('`when.path` matches anything under it', () => {
  assert.equal(verdictFor({ path: '/repo/src' }, req({ path: '/repo/src/app/main.ts' })), 'allow');
});

test('`when.path` does NOT match a sibling sharing a string prefix', () => {
  // The `/repo/src` vs `/repo/src-old` case. A naive startsWith() would allow it.
  assert.equal(verdictFor({ path: '/repo/src' }, req({ path: '/repo/src-old/main.ts' })), 'ask');
  assert.equal(verdictFor({ path: '/repo/src' }, req({ path: '/repo/srcx' })), 'ask');
});

test('`when.path` does NOT match a relative pattern', () => {
  assert.equal(verdictFor({ path: 'src' }, req({ path: '/repo/src' })), 'ask');
});

test('`when.path` does NOT match a glob pattern', () => {
  // Unsupported patterns must never match: for a deny rule a silent no-match is
  // fail-open, so validateRules has to make the loader skip it loudly.
  assert.equal(verdictFor({ path: '/repo/**' }, req({ path: '/repo/src/a.ts' })), 'ask');
});

test('`when.path` does NOT match the filesystem root', () => {
  for (const root of ['/', '\\', '//']) {
    assert.equal(verdictFor({ path: root }, req({ path: '/repo/src/a.ts' })), 'ask', root);
  }
});

test('`when.path` does NOT match when the request carries no path', () => {
  assert.equal(verdictFor({ path: '/repo/src' }, req()), 'ask', 'fail closed, never "do not care"');
});

test('a trailing separator on the pattern is accepted and harmless', () => {
  assert.equal(verdictFor({ path: '/repo/src/' }, req({ path: '/repo/src' })), 'allow');
  assert.equal(verdictFor({ path: '/repo/src/' }, req({ path: '/repo/src/a.ts' })), 'allow');
});

test('path matching is separator-agnostic, so one rule text works on both platforms', () => {
  assert.equal(verdictFor({ path: 'C:\\repo\\src' }, req({ path: 'C:/repo/src/a.ts' })), 'allow');
  assert.equal(verdictFor({ path: 'C:/repo/src' }, req({ path: 'C:\\repo\\src\\a.ts' })), 'allow');
});

test('a Windows drive pattern does not match a POSIX path', () => {
  assert.equal(verdictFor({ path: 'C:\\repo' }, req({ path: '/repo/src/a.ts' })), 'ask');
});

// ---------------------------------------------------------------------------
// command — prefix only, with a word boundary
// ---------------------------------------------------------------------------

test('`when.command` matches exactly and as a prefix', () => {
  assert.equal(verdictFor({ command: 'npm run test' }, req({ command: 'npm run test' })), 'allow');
  assert.equal(verdictFor({ command: 'npm run test' }, req({ command: 'npm run test --watch' })), 'allow');
});

test('`when.command` respects a boundary, so a longer word does not match', () => {
  assert.equal(verdictFor({ command: 'npm run test' }, req({ command: 'npm run testing' })), 'ask');
});

test('`when.command` matches the raw text only — no shell awareness', () => {
  // ADR-027: prefix only, and deliberately no `&&` / pipe parsing. The compound
  // command below does not start with the pattern, so a rule written for the
  // first half does not cover it. This is the documented boundary, not a bug.
  assert.equal(verdictFor({ command: 'git diff' }, req({ command: 'cd /tmp && git diff' })), 'ask');
});

test('`when.command` does NOT match when the request carries no command', () => {
  assert.equal(verdictFor({ command: 'npm test' }, req()), 'ask');
});

// ---------------------------------------------------------------------------
// fields are ANDed
// ---------------------------------------------------------------------------

test('present fields must all match', () => {
  const when = { tool: 'Bash', risk: 'exec', command: 'npm test' } as const;
  assert.equal(verdictFor(when, req({ name: 'Bash', risk: 'exec', command: 'npm test --ci' })), 'allow');
  assert.equal(verdictFor(when, req({ name: 'Bash', risk: 'exec', command: 'npm build' })), 'ask');
  assert.equal(verdictFor(when, req({ name: 'Bash', risk: 'read', command: 'npm test' })), 'ask');
  assert.equal(verdictFor(when, req({ name: 'Read', risk: 'exec', command: 'npm test' })), 'ask');
});

// ---------------------------------------------------------------------------
// precedence still holds with structured rules
// ---------------------------------------------------------------------------

test('precedence holds on structured rules too', () => {
  const rules: readonly Rule[] = [
    { name: 'allow-project', when: { path: '/repo' }, verdict: 'allow' },
    { name: 'ask-writes', when: { risk: 'write' }, verdict: 'ask' },
    { name: 'deny-secrets', when: { path: '/repo/secrets' }, verdict: 'deny' },
  ];
  const decision = decide(req({ path: '/repo/secrets/key.pem' }), rules);
  assert.equal(decision.verdict, 'deny', 'the narrower deny still wins');
  assert.equal(decision.rule, 'deny-secrets');
  assert.equal(decide(req({ path: '/repo/notes.md' }), rules).verdict, 'ask');
});

// ---------------------------------------------------------------------------
// validateRules — the channel that lets the loader skip a bad rule and warn
// ---------------------------------------------------------------------------

test('validateRules accepts the shipped defaults and the empty `when` form', () => {
  assert.deepEqual(validateRules([rule({ risk: 'read' }), rule({}), rule({ tool: '*' })]), []);
});

test('validateRules reports a glob path, because decide cannot honour it', () => {
  const problems = validateRules([rule({ path: '/repo/**' }, 'deny')]);
  assert.equal(problems.length, 1);
  const [first] = problems;
  assert.ok(first);
  assert.equal(first.rule, 'r');
  assert.equal(first.index, 0);
  assert.match(first.problem, /glob/);
});

test('validateRules reports a relative path and the filesystem root', () => {
  assert.match(firstProblem([rule({ path: 'src' })]), /not absolute/);
  assert.match(firstProblem([rule({ path: '/' })]), /filesystem root/);
});

test('validateRules reports an empty name, empty selectors and unknown risks', () => {
  assert.deepEqual(problemsFor([{ name: '  ', when: {}, verdict: 'allow' }]), ['rule name is empty']);
  assert.match(firstProblem([rule({ tool: [] })]), /when\.tool/);
  assert.match(firstProblem([rule({ command: '   ' })]), /when\.command/);
  assert.match(firstProblem([rule({ risk: 'writey' as never })]), /unknown risk/);
});

test('validateRules reports the index of each problem so a warning can name the entry', () => {
  const problems = validateRules([rule({}), rule({ path: '/a/**' }), rule({ command: '' })]);
  assert.deepEqual(problems.map((p) => p.index), [1, 2]);
});
