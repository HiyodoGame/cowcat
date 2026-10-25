import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCommand, parseCommand, type CommandEffect } from '../src/app/commands.js';
import { initialView } from '../src/app/view.js';

function effectOf(name: string, rest = ''): CommandEffect {
  const command = findCommand(name);
  assert.ok(command !== undefined);
  return command.run({ ...initialView(), model: 'claude-sonnet-5-5' }, rest);
}

test('slash commands receive their argument text', () => {
  const parsed = parseCommand('/model openai/gpt-6.1-sol');
  assert.equal(parsed?.rest, 'openai/gpt-6.1-sol');
  assert.deepEqual(effectOf('model', 'openai/gpt-6.1-sol'), { kind: 'model', preset: 'openai/gpt-6.1-sol', effort: undefined });
  assert.deepEqual(effectOf('model'), { kind: 'model', preset: null, effort: undefined });
});

test('/compact asks the host for a manual compaction', () => {
  assert.deepEqual(effectOf('compact'), { kind: 'compact' });
});

test('/config shows settings or changes only model and effort', () => {
  const current = effectOf('config');
  assert.equal(current.kind, 'notice');
  assert.match(current.text, /claude-sonnet-5-5/);
  assert.deepEqual(effectOf('config', 'model=openai/gpt-6.1-sol'), { kind: 'model', preset: 'openai/gpt-6.1-sol', effort: undefined });
  assert.deepEqual(effectOf('config', 'effort=high'), { kind: 'model', preset: null, effort: 'high' });
  const invalid = effectOf('config', 'theme=dark');
  assert.equal(invalid.kind, 'notice');
  assert.match(invalid.text, /只支持 model 和 effort/);
});

test('/cost asks for a usage breakdown', () => {
  assert.deepEqual(effectOf('cost'), { kind: 'cost' });
});
