// P6 T4a 2/3 — the config layers the composition root reads (ADR-064), on top of the
// merge semantics P3 already pinned down (ADR-025/026).
//
// Two things here are the host's own judgement and have no earlier test:
//
//   * a file that is NOT THERE is silence, while a file that IS THERE and cannot be read
//     refuses the whole load. Collapsing the two starts a session on the built-in
//     defaults while the user believes their file is in effect.
//   * which files, in which order — user, then project, then the session's `--config`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  CONFIG_DIR_NAME,
  DEFAULT_CONFIG,
  HOST_BASELINE_RULES,
  PROJECT_CONFIG_FILENAME,
  SESSIONS_DIR_NAME,
  TRUST_FILENAME,
  cowcatPaths,
  decide,
  loadHostConfig,
  withHostRules,
  type ActionRequest,
  type ConfigError,
  type HostConfigOptions,
  type HostConfigResult,
  type Rule,
} from '../src/index.js';

const cwd = join('', 'work', 'proj');
const home = join('', 'home', 'u');
const userConfig = join(home, CONFIG_DIR_NAME, 'config.json');
const projectConfig = join(cwd, PROJECT_CONFIG_FILENAME);
const sessionConfig = join('', 'tmp', 'explicit.json');

/**
 * A reader over a map, plus the two failures that matter: absent (`ENOENT`) and present
 * but unreadable. It records the paths it was asked for, because the ORDER is part of
 * what the loader promises.
 */
function reader(files: Readonly<Record<string, string>>, unreadable: readonly string[] = []) {
  const attempts: string[] = [];
  const read = (path: string): Promise<string> => {
    attempts.push(path);
    if (unreadable.includes(path)) {
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' }));
    }
    const text = files[path];
    if (text === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' }));
    }
    return Promise.resolve(text);
  };
  return { attempts, read };
}

const allow = (name: string): Rule => ({ name, verdict: 'allow', when: { tool: 'Bash' } });
const ask = (name: string): Rule => ({ name, verdict: 'ask', when: { risk: 'exec' } });

// Narrowing by assertion (assert.equal narrows a discriminant, which then makes every
// later `if (!result.ok)` a lint error — the same trap HANDOFF §5 records).
function expectLoaded(result: HostConfigResult): Extract<HostConfigResult, { readonly ok: true }> {
  if (!result.ok) throw new Error(`expected the config to load: ${result.errors.map((error) => error.problem).join('; ')}`);
  return result;
}

function expectRefused(result: HostConfigResult): readonly ConfigError[] {
  if (result.ok) throw new Error('expected the config to be refused');
  return result.errors;
}

function load(options: HostConfigOptions): Promise<HostConfigResult> {
  return loadHostConfig(options);
}

test('the layout puts sessions, trust and the two config files where ADR-064 says', () => {
  const paths = cowcatPaths({ cwd, home });
  assert.equal(paths.dir, join(home, CONFIG_DIR_NAME));
  assert.equal(paths.sessionsDir, join(paths.dir, SESSIONS_DIR_NAME));
  assert.equal(paths.trustFile, join(paths.dir, TRUST_FILENAME));
  assert.equal(paths.userConfig, join(paths.dir, 'config.json'));
  // The project layer is the WORKSPACE's file, not one under `~/.cowcat` — that is the
  // whole reason it needs the trust gate (ADR-028).
  assert.equal(paths.projectConfig, join(cwd, PROJECT_CONFIG_FILENAME));
});

test('no config file at all means the built-in defaults, and nothing to report', async () => {
  const { attempts, read } = reader({});
  const result = expectLoaded(await load({ cwd, home, readTextFile: read }));

  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.warnings, []);
  // User, then project. The session layer is only read when the caller named one.
  assert.deepEqual(attempts, [userConfig, projectConfig]);
});

test('the three layers merge in order: user, project, then the session file', async () => {
  const { attempts, read } = reader({
    [userConfig]: JSON.stringify({
      sandbox: { network: 'off', read: { deny: ['/secrets'] } },
      model: { preset: 'anthropic/claude-sonnet-5-5' },
      rules: [allow('user-allow')],
    }),
    [projectConfig]: JSON.stringify({
      sandbox: { network: 'ask', read: { deny: ['/other'] } },
      model: { effort: 'high' },
      rules: [ask('project-ask')],
    }),
    [sessionConfig]: JSON.stringify({ model: { preset: 'openai/gpt-5' }, rules: [allow('session-allow')] }),
  });

  const result = expectLoaded(await load({ cwd, home, sessionConfigPath: sessionConfig, readTextFile: read }));

  assert.deepEqual(attempts, [userConfig, projectConfig, sessionConfig]);
  assert.equal(result.files.length, 3);

  // Scalars: the last layer that named one wins. Lists: concatenated, never overridden —
  // a later layer must not be able to delete an earlier deny by not mentioning it.
  assert.equal(result.config.sandbox.network, 'ask');
  assert.equal(result.config.model.preset, 'openai/gpt-5');
  assert.equal(result.config.model.effort, 'high');
  assert.deepEqual(result.config.sandbox.read.deny.slice(-2), ['/secrets', '/other']);

  assert.deepEqual(
    result.config.rules.map((sourced) => sourced.rule.name),
    [...DEFAULT_CONFIG.rules.map((sourced) => sourced.rule.name), 'user-allow', 'project-ask', 'session-allow'],
  );
  // The origin travels with the rule because trust is a statement about the workspace
  // and only the origin says which rules the workspace supplied (ADR-028).
  assert.deepEqual(
    result.config.rules.map((sourced) => sourced.origin),
    ['default', 'user', 'project', 'session'],
  );
});

test('a file that exists but cannot be read refuses the load, and names itself', async () => {
  const { read } = reader({}, [userConfig]);
  const errors = expectRefused(await load({ cwd, home, readTextFile: read }));

  assert.deepEqual(errors.map((error) => error.source), [userConfig]);
  assert.match(errors.map((error) => error.problem).join('; '), /cannot be read: EACCES/);
});

test('a malformed layer refuses the whole load, even when another layer is fine', async () => {
  const { read } = reader({
    [userConfig]: '{"model": {"preset":',
    [projectConfig]: JSON.stringify({ model: { preset: 'openai/gpt-5' } }),
  });
  const errors = expectRefused(await load({ cwd, home, readTextFile: read }));

  // Not "start on the defaults and warn": the user believes their file is in effect, and
  // a session that runs on values nobody configured is the failure ADR-025 decision 5
  // separates from a single bad entry.
  assert.deepEqual(errors.map((error) => error.source), [userConfig]);
  assert.match(errors.map((error) => error.problem).join('; '), /not valid JSON/);
});

test('an unknown key in a config file is a typo, not something to ignore', async () => {
  const { read } = reader({ [projectConfig]: JSON.stringify({ rulez: [] }) });
  const errors = expectRefused(await load({ cwd, home, readTextFile: read }));

  assert.match(errors.map((error) => error.problem).join('; '), /rulez/);
});

test('the host baseline makes TodoWrite free, and a deny from any layer still wins', () => {
  const todo: ActionRequest = { kind: 'tool', callId: 'c1', name: 'TodoWrite', risk: 'write', input: {} };

  assert.equal(decide(todo, withHostRules([])).verdict, 'allow');
  assert.deepEqual(withHostRules([]), HOST_BASELINE_RULES);

  // The library's own baseline stays one rule (ADR-034): this is the composition root's
  // decision, not the kernel's.
  assert.equal(
    DEFAULT_CONFIG.rules.some((sourced) => sourced.rule.name === HOST_BASELINE_RULES[0]?.name),
    false,
  );

  // Appending it cannot weaken anything: `decide` picks by category, so a deny outranks
  // an allow whatever the order.
  const denied = withHostRules([{ name: 'no-todos-here', verdict: 'deny', when: { tool: 'TodoWrite' } }]);
  const decision = decide(todo, denied);
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.rule, 'no-todos-here');
});
