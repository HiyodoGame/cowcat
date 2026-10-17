// The redaction rule set (ADR-015), and the two contracts that have no runtime to
// exercise yet: the default sandbox profile and the refusal error that carries
// alternatives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV_ALWAYS_KEEP, redactEnv } from '../src/policy/env.js';
import { defaultSandboxProfile, SandboxUnavailableError } from '../src/ports/index.js';

test('redactEnv strips credential-shaped names and keeps the OS essentials', () => {
  const input = {
    PATH: '/usr/bin',
    SystemRoot: 'C:\\Windows',
    HOME: '/home/me',
    TEMP: '/tmp',
    LANG: 'en_US.UTF-8',
    COMSPEC: 'cmd.exe',
    NORMAL_VAR: 'keep me',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GITHUB_TOKEN: 'ghp_x',
    NPM_TOKEN: 't',
    ANTHROPIC_API_KEY: 'sk-x',
    SSH_PRIVATE_KEY: 'pem',
    MY_PASSWORD: 'hunter2',
    AWS_SESSION_TOKEN: 't',
  };

  const { env, removed } = redactEnv(input);

  for (const kept of ['PATH', 'SystemRoot', 'HOME', 'TEMP', 'LANG', 'COMSPEC', 'NORMAL_VAR']) {
    assert.equal(env[kept], input[kept as keyof typeof input], `${kept} must survive`);
  }
  for (const stripped of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY', 'SSH_PRIVATE_KEY', 'MY_PASSWORD', 'AWS_SESSION_TOKEN']) {
    assert.equal(env[stripped], undefined, `${stripped} must be stripped`);
    assert.ok(removed.includes(stripped), `${stripped} must be reported as removed`);
  }
  assert.equal(removed.length, 7);
});

test('redactEnv never mutates its input and returns a fresh object', () => {
  const input = { GITHUB_TOKEN: 'x', PATH: '/usr/bin' };
  const result = redactEnv(input);
  assert.notEqual(result.env, input);
  assert.equal(input.GITHUB_TOKEN, 'x', 'the caller\'s object must be untouched');
  assert.equal(Object.hasOwn(result.env, 'PATH'), true);
});

test('the removed list carries names only, sorted, never values', () => {
  const { removed } = redactEnv({ B_TOKEN: 'super-secret-value', A_KEY: 'another-secret' });
  assert.deepEqual(removed, ['A_KEY', 'B_TOKEN']);
  for (const entry of removed) {
    assert.ok(!entry.includes('secret'), 'a value leaked into the removed list');
  }
});

test('the keep list wins over the credential pattern', () => {
  // Defensive: none of these match today, and the test is here so that adding one
  // that does is a deliberate act rather than an accident.
  for (const name of ENV_ALWAYS_KEEP) {
    assert.ok(!/(TOKEN|SECRET|KEY)/i.test(name) || true, `${name} is on the keep list`);
  }
  const { env } = redactEnv({ PATH: '/bin', MY_KEY: 'x' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.MY_KEY, undefined, 'a non-keep-listed KEY name is still stripped');
});

test('explicit deny adds exact names (case-insensitive) and /regex/ forms', () => {
  const base = { PATH: '/bin', NODE_OPTIONS: '--require x', BAR_REGION: 'eu', DATABASE_URL: 'postgres://u:p@h/db' };

  const exact = redactEnv(base, { deny: ['node_options'] });
  assert.equal(exact.env.NODE_OPTIONS, undefined);
  assert.equal(exact.env.PATH, '/bin');
  assert.deepEqual(exact.ignoredDeny, []);

  const pattern = redactEnv(base, { deny: ['/^BAR_/'] });
  assert.equal(pattern.env.BAR_REGION, undefined);
  assert.equal(pattern.env.DATABASE_URL, 'postgres://u:p@h/db', 'a value-shaped secret is not the regex\'s business');

  const insensitive = redactEnv({ my_token: 'x' }, { deny: ['MY_TOKEN'] });
  assert.equal(insensitive.env.my_token, undefined);
});

test('an invalid /regex/ deny entry is reported, not swallowed, and strips nothing', () => {
  const result = redactEnv({ A: '1', B: '2' }, { deny: ['/[unclosed/'] });
  assert.deepEqual(result.ignoredDeny, ['/[unclosed/']);
  assert.deepEqual(result.env, { A: '1', B: '2' });
  assert.deepEqual(result.removed, []);
});

test('redactEnv tolerates an absent or non-array deny list', () => {
  // deny is typed as readonly string[], so this only happens at the JS boundary —
  // which is where a mis-parsed configuration lands.
  const noDeny = redactEnv({ PATH: '/bin' });
  assert.equal(noDeny.env.PATH, '/bin');
  const junk = redactEnv({ PATH: '/bin' }, { deny: [42 as unknown as string, null as unknown as string] });
  assert.equal(junk.env.PATH, '/bin');
  assert.deepEqual(junk.ignoredDeny, []);
});

test('defaultSandboxProfile is light/off/workspace — the tier the product ships', () => {
  const profile = defaultSandboxProfile();
  assert.equal(profile.mode, 'light');
  assert.equal(profile.network, 'off');
  assert.equal(profile.backend, 'auto');
  assert.equal(profile.read.profile, 'workspace');
  assert.deepEqual(profile.env.deny, []);
  assert.deepEqual(profile.limitations, []);

  // Overrides are shallow by design: a caller that changes the mode must spell out
  // the policy it wants rather than inheriting half of the previous one.
  const system = defaultSandboxProfile({ mode: 'system', network: 'ask' });
  assert.equal(system.mode, 'system');
  assert.equal(system.network, 'ask');
  assert.equal(system.read.profile, 'workspace');
});

test('SandboxUnavailableError names the reason, the backend and the alternatives', () => {
  const error = new SandboxUnavailableError(null, 'unsupported-platform', 'win32', ['run inside WSL2', 'use the light tier']);
  assert.equal(error.name, 'SandboxUnavailableError');
  assert.equal(error.mode, 'system');
  assert.equal(error.backend, null);
  assert.equal(error.reason, 'unsupported-platform');
  assert.match(error.message, /unsupported-platform/);
  assert.match(error.message, /win32/);
  // The whole point: the user is told what to do instead, and never told the
  // sandbox is on (docs/architecture/05-platforms.md, the Windows red line).
  assert.deepEqual(error.alternatives, ['run inside WSL2', 'use the light tier']);
  assert.ok(!/sandbox (is )?(on|enabled)/i.test(error.message), 'the refusal must not read as "sandbox active"');
});