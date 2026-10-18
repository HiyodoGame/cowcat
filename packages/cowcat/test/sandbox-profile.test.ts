import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  DEFAULT_SANDBOX_SETTINGS,
  loadConfig,
  resolveConfig,
  resolveSandboxProfile,
  type ConfigSource,
} from '../src/index.js';
import { fakeFs } from './support.js';

const source = (kind: 'user' | 'project' | 'session', body: unknown): ConfigSource => ({
  kind,
  path: `<${kind}>`,
  text: JSON.stringify(body),
});

test('the sandbox defaults are the layer-0 settings, unchanged by an empty config', () => {
  assert.deepEqual(DEFAULT_CONFIG.sandbox, DEFAULT_SANDBOX_SETTINGS);
  assert.deepEqual(resolveConfig({}).sandbox, DEFAULT_SANDBOX_SETTINGS);
  assert.equal(DEFAULT_SANDBOX_SETTINGS.network, 'off');
  assert.equal(DEFAULT_SANDBOX_SETTINGS.mode, 'light');
});

test('scalars take the last layer that named them, and lists concatenate', () => {
  const config = resolveConfig({
    user: { sandbox: { network: 'ask', read: { deny: ['~/.secrets'] } } },
    project: { sandbox: { mode: 'system' } },
  });

  assert.equal(config.sandbox.mode, 'system');
  assert.equal(config.sandbox.network, 'ask');
  // The default deny list is still there: a later layer cannot delete an earlier deny.
  assert.deepEqual(config.sandbox.read.deny, [...DEFAULT_SANDBOX_SETTINGS.read.deny, '~/.secrets']);
});

test('a config file can set the sandbox keys, and a typo inside them is refused', () => {
  const ok = loadConfig([source('project', { sandbox: { mode: 'system', network: 'ask', write: { allow: ['../shared'] } } })]);
  assert.equal(ok.ok, true);
  assert.equal(ok.config.sandbox.mode, 'system');
  assert.equal(ok.config.sandbox.network, 'ask');
  assert.deepEqual(ok.config.sandbox.write.allow, ['.', '../shared']);

  // Strict all the way down: an unknown key here is a typo, not a newer writer.
  const typo = loadConfig([source('project', { sandbox: { network: 'of' } })]);
  assert.equal(typo.ok, false);
  assert.match(typo.errors[0]?.problem ?? '', /sandbox\.network/);
});

test('resolving the profile turns human paths into canonical identities', () => {
  const cwd = 'C:/repo';
  const home = 'C:/Users/dev';
  const { profile, unsupported } = resolveSandboxProfile(DEFAULT_SANDBOX_SETTINGS, {
    cwd,
    home,
    fs: fakeFs(),
  });

  assert.deepEqual(profile.read.deny, ['C:/Users/dev/.ssh', 'C:/Users/dev/.config/gh', 'C:/Users/dev/.git-credentials', 'C:/Users/dev/.cowcat', 'C:/Users/dev/.aws', 'C:/Users/dev/.gnupg']);
  assert.deepEqual(profile.read.allow, ['C:/Users/dev/.gitconfig', 'C:/Users/dev/.npm', 'C:/Users/dev/.cache']);
  // `.` is the workspace: a sandbox that cannot write the project is one users turn off.
  assert.deepEqual(profile.write.allow, ['C:/repo']);
  assert.deepEqual(profile.write.deny, ['C:/repo/.env', 'C:/repo/.git/hooks']);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(profile.limitations, []);
});

test('an entry the backend cannot honour is surfaced, not silently dropped', () => {
  const { profile, unsupported } = resolveSandboxProfile(
    { ...DEFAULT_SANDBOX_SETTINGS, read: { ...DEFAULT_SANDBOX_SETTINGS.read, deny: ['**/*.env'] } },
    { cwd: 'C:/repo', home: 'C:/Users/dev', fs: fakeFs() },
  );

  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0]?.entry, '**/*.env');
  assert.equal(profile.limitations.length, 1);
  assert.match(profile.limitations[0] ?? '', /was not applied/);
  // And the bad entry is NOT in the deny list, where it would look like a working rule.
  assert.equal(profile.read.deny.includes('**/*.env'), false);
});
