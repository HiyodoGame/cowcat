// P3 T2b — the configuration layers (ADR-025) and their merge semantics (ADR-026).
//
// Two things here are load-bearing and neither is obvious from the code:
//
//   * a source that cannot be decoded REFUSES the whole load, while a single bad
//     entry is only skipped. Starting on the built-in defaults while the user
//     believes their file is in effect is the failure the two tiers separate.
//   * a config document is STRICT about unknown keys, the opposite of the session
//     log. A log's unknown key means "a newer writer"; a config's unknown key is a
//     typo, and ignoring it is the bug ADR-025 decision 5 exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LAYERS, DEFAULT_CONFIG, loadConfig, resolveConfig, type ConfigSource, type Rule } from '../src/index.js';
import { ruleSchema, ruleWhenSchema } from '../src/adapters/config.js';

const src = (kind: ConfigSource['kind'], body: unknown, path = `/${kind}/cowcat.json`): ConfigSource => ({
  kind,
  path,
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

const rule = (name: string, verdict: Rule['verdict'], when: Rule['when'] = {}): Rule => ({ name, verdict, when });

const deny = (name: string, path: string): Rule => ({ name, verdict: 'deny', when: { path } });

// ---------------------------------------------------------------------------
// Layer order and list merge (ADR-025 decision 1, ADR-026)
// ---------------------------------------------------------------------------

test('with no layers at all, the built-in defaults are what runs', () => {
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG);
  assert.equal(resolveConfig({}).rules.length, DEFAULT_CONFIG.rules.length);
});

test('lists concatenate in layer order: defaults, user, project, session', () => {
  const config = resolveConfig({
    user: { rules: [rule('u', 'allow')] },
    project: { rules: [rule('p', 'allow')] },
    session: { rules: [rule('s', 'allow')] },
  });
  assert.deepEqual(
    config.rules.map((s) => s.rule.name),
    [...DEFAULT_CONFIG.rules.map((s) => s.rule.name), 'u', 'p', 's'],
  );
});

test('each rule remembers which layer it came from', () => {
  const config = resolveConfig({
    user: { rules: [rule('u', 'allow')] },
    project: { rules: [rule('p', 'allow')] },
    session: { rules: [rule('s', 'allow')] },
  });
  const originOf = (name: string): string | undefined => config.rules.find((s) => s.rule.name === name)?.origin;
  assert.equal(originOf('u'), 'user');
  assert.equal(originOf('p'), 'project');
  assert.equal(originOf('s'), 'session');
  assert.equal(config.rules[0]?.origin, 'default', 'and the built-in baseline is stamped too');
});

test('a layer that says nothing about a key does not override it', () => {
  const config = resolveConfig({ user: { rules: [rule('u', 'allow')] }, project: {}, session: {} });
  assert.equal(config.rules.filter((s) => s.rule.name === 'u').length, 1);
  assert.equal(config.rules.length, DEFAULT_CONFIG.rules.length + 1);
});

test('the three layer names are exactly user, project, session', () => {
  assert.deepEqual([...CONFIG_LAYERS], ['user', 'project', 'session']);
});

test('a lower layer narrows a higher one, which is how an allow is revoked', () => {
  // The question ADR-026 has to answer: with lists merging, how do you undo an allow
  // from another layer? By writing a deny, because deny wins regardless of order
  // (ADR-023) — no negation syntax needed.
  const config = resolveConfig({
    user: { rules: [{ name: 'allow-docs', verdict: 'allow', when: { path: '/repo/docs' } }] },
    project: { rules: [{ name: 'deny-secrets', verdict: 'deny', when: { path: '/repo/docs/secrets' } }] },
  });
  const names = config.rules.map((s) => s.rule.name);
  assert.ok(names.indexOf('deny-secrets') > names.indexOf('allow-docs'), 'written later, and still wins');
});

// ---------------------------------------------------------------------------
// Tier 1: a source that cannot be decoded refuses the load
// ---------------------------------------------------------------------------

test('a valid document decodes with no warnings', () => {
  const result = loadConfig([src('user', { rules: [rule('u', 'allow')] })]);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, []);
});

test('malformed JSON refuses the load and names the file', () => {
  const result = loadConfig([src('user', '{ not json')]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.problem ?? '', /not valid JSON/);
  assert.equal(result.errors[0]?.source, '/user/cowcat.json');
});

test('a non-object document refuses the load', () => {
  for (const body of ['[1,2]', '"a string"', '7', 'null']) {
    const result = loadConfig([src('user', body)]);
    assert.equal(result.ok, false, body);
  }
});

test('an unknown TOP-LEVEL key refuses the load, and the message names it', () => {
  // The typo case. Note the deliberate contrast with a session log, where an unknown
  // key is stripped instead (adapters/schema.ts): a log's extra key is a newer
  // writer, a config file's extra key is a mistake.
  const result = loadConfig([src('project', { rulez: [] })]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  const [firstError] = result.errors;
  assert.ok(firstError);
  assert.equal(firstError.source, '/project/cowcat.json');
  assert.match(firstError.problem, /rulez/);
});

test('refusing beats warning: one bad source and there is no config at all', () => {
  const result = loadConfig([
    src('user', { rules: [rule('u', 'allow')] }),
    src('project', { rulez: [] }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.errors.length, 1);
});

test('every bad source is reported, not just the first', () => {
  const result = loadConfig([src('user', '{'), src('project', '{'), src('session', '{')]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.errors.map((e) => e.source).sort(), [
    '/project/cowcat.json',
    '/session/cowcat.json',
    '/user/cowcat.json',
  ]);
});

// ---------------------------------------------------------------------------
// Tier 2: one bad entry is skipped, the rest survives
// ---------------------------------------------------------------------------

test('a rule with an unknown verdict is skipped, and the others survive', () => {
  const result = loadConfig([
    src('user', { rules: [rule('good', 'allow'), { name: 'bad', verdict: 'maybe', when: {} }, rule('also-good', 'deny')] }),
  ]);
  assert.ok(result.ok);
  assert.deepEqual(result.config.rules.map((s) => s.rule.name).filter((n) => n === 'good' || n === 'also-good' || n === 'bad'), ['good', 'also-good']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.problem ?? '', /rules\[1\]/);
});

test('a typo inside a rule is skipped and reported with its index', () => {
  const result = loadConfig([src('user', { rules: [{ name: 'r', verdict: 'allow', matchs: {} }] })]);
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.problem ?? '', /rules\[0\]/);
  assert.equal(result.config.rules.filter((s) => s.rule.name === 'r').length, 0);
});

test('a rule rule that decide cannot honour is skipped through the same channel', () => {
  // validateRules (T1) is what turns "a glob path" into a warning instead of a rule
  // that silently never matches — which for a deny would be fail-open.
  const result = loadConfig([src('user', { rules: [deny('glob-deny', '/repo/**'), deny('ok-deny', '/repo/secrets')] })]);
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.problem ?? '', /glob/);
  assert.deepEqual(result.config.rules.filter((s) => s.rule.verdict === 'deny').map((s) => s.rule.name), ['ok-deny']);
});

test('a bad entry in one layer does not disturb another layer', () => {
  const result = loadConfig([
    src('user', { rules: [{ name: 'bad', verdict: 'nope', when: {} }] }),
    src('project', { rules: [rule('p', 'allow')] }),
  ]);
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.config.rules.filter((s) => s.rule.name === 'p').length, 1);
});

test('warnings name the source they came from', () => {
  const result = loadConfig([src('session', { rules: [{ name: 'bad', verdict: 'nope', when: {} }] }, '<session>')]);
  assert.ok(result.ok);
  assert.equal(result.warnings[0]?.source, '<session>');
});

// ---------------------------------------------------------------------------
// Decoded shapes: no undefined-when-absent, and the key sets must not drift
// ---------------------------------------------------------------------------

test('an omitted reason is absent, not present-and-undefined', () => {
  const result = loadConfig([src('user', { rules: [rule('u', 'allow')] })]);
  assert.ok(result.ok);
  const loaded = result.config.rules.find((s) => s.rule.name === 'u')?.rule;
  assert.ok(loaded);
  assert.ok(!('reason' in loaded), 'a present-but-undefined field would survive JSON round trips differently');
});

test('only the `when` fields the document set are present', () => {
  const result = loadConfig([src('user', { rules: [{ name: 'u', verdict: 'ask', when: { risk: 'exec' } }] })]);
  assert.ok(result.ok);
  const loaded = result.config.rules.find((s) => s.rule.name === 'u')?.rule;
  assert.ok(loaded);
  assert.deepEqual(Object.keys(loaded.when), ['risk']);
});

// Compile-time drift guards, in the style of test/schema.test.ts. A field added to
// `Rule`/`RuleWhen` but not to the schema (or the reverse) makes the build fail here
// instead of surfacing as a setting that silently cannot be written.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ruleKeys: Equals<keyof Rule, keyof ReturnType<typeof ruleSchema.parse>> = true;
const whenKeys: Equals<keyof Rule['when'], keyof ReturnType<typeof ruleWhenSchema.parse>> = true;

test('the schema and the Rule types hold the same keys', () => {
  assert.equal(ruleKeys, true);
  assert.equal(whenKeys, true);
});

// ---------------------------------------------------------------------------
// v1 compatibility (ADR-089)
// ---------------------------------------------------------------------------

test('a v1 config is translated: model string, providers with inline keys, sandbox', () => {
  const loaded = loadConfig([
    src('user', {
      model: 'zai-coding-plan/glm-5.3-flash',
      providers: {
        'zai-coding-plan': { apiKey: 'sk-inline-test' },
        'volcengine-coding-plan': { apiKey: 'ark-inline-test' },
      },
      sandbox: 'off',
    }),
  ]);

  assert.ok(loaded.ok);
  assert.equal(loaded.config.model.preset, 'zai-coding-plan/glm-5.3-flash');
  assert.equal(loaded.config.model.providers['zai-coding-plan']?.apiKey, 'sk-inline-test');
  assert.equal(loaded.config.sandbox.mode, 'off');
  const problems = loaded.warnings.map((warning) => warning.problem).join('\n');
  assert.match(problems, /legacy v1 config/u);
  assert.match(problems, /inline apiKey/u);
  // The value must never travel into a warning (ADR-089).
  assert.ok(!problems.includes('sk-inline-test'));
  assert.ok(!problems.includes('ark-inline-test'));
});

test('v1 sandbox objects map envDeny, and v1 permissions are reported as not migrated', () => {
  const loaded = loadConfig([
    src('user', {
      model: 'anthropic/claude-sonnet-5-5',
      sandbox: { envDeny: ['MY_SECRET', '/^FOO_/', 42] },
      permissions: [{ tool: 'Bash', allow: true }],
      maxTokens: 1234,
    }),
  ]);

  assert.ok(loaded.ok);
  assert.deepEqual(loaded.config.sandbox.env.deny, ['MY_SECRET', '/^FOO_/']);
  const problems = loaded.warnings.map((warning) => warning.problem).join('\n');
  assert.match(problems, /permissions are not migrated/u);
  assert.match(problems, /maxTokens/u);
});

test('a v2 document still refuses an inline apiKey: compatibility is shape-gated', () => {
  const loaded = loadConfig([
    src('user', {
      model: { preset: 'acme/gpt-x', providers: { acme: { apiKey: 'sk-should-not-be-accepted' } } },
    }),
  ]);
  assert.ok(!loaded.ok);
  assert.match(loaded.errors.map((error) => error.problem).join('\n'), /apiKey/u);
});

test('a malformed v1 model or providers ref is a load error, not a silent default', () => {
  const model = loadConfig([src('user', { model: 'no-slash' })]);
  assert.ok(!model.ok);
  assert.match(model.errors[0]?.problem ?? '', /provider\/model/u);

  const providers = loadConfig([src('user', { model: 'a/b', providers: [] })]);
  assert.ok(!providers.ok);
  assert.match(providers.errors[0]?.problem ?? '', /providers must be an object/u);
});
