// P5: startup model-ref hints — nearestRefs / catalogRefs / formatModelHint.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nearestRefs, catalogRefs, formatModelHint } from '../src/modelhint.js';

const REFS = [
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-4-9',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-6',
  'openai/gpt-6-sol',
  'openai/o4-mini',
  'moonshotai/kimi-k3',
];

test('nearestRefs ranks obvious kin first', () => {
  const near = nearestRefs('anthropic/claude-sonnet-5', REFS, 5);
  assert.equal(near[0], 'anthropic/claude-sonnet-5-5');
  assert.ok(near.includes('anthropic/claude-haiku-4-5'));
});

test('nearestRefs tolerates a wrong provider prefix via the bare model id', () => {
  const near = nearestRefs('openrouter/claude-sonnet-5-5', REFS, 5);
  assert.equal(near[0], 'anthropic/claude-sonnet-5-5');
});

test('nearestRefs: exact match -> [], limit respected', () => {
  assert.deepEqual(nearestRefs('openai/gpt-6', REFS, 5), []);
  assert.equal(nearestRefs('anthropic/claude-sonnet-5', REFS, 3).length, 3);
  assert.equal(nearestRefs('zz/qq', [], 5).length, 0);
});

test('catalogRefs enumerates preset provider/model refs', () => {
  const refs = catalogRefs({});
  assert.ok(refs.includes('anthropic/claude-sonnet-5-5'), 'preset refs must be present');
  assert.ok(refs.every((r) => r.includes('/')));
});

test('catalogRefs includes user-defined provider models', () => {
  const refs = catalogRefs({
    providers: {
      mygateway: { protocol: 'openai', baseURL: 'https://gw.example.com/v1', models: { 'my-model': { name: 'My Model' } } },
    },
  });
  assert.ok(refs.includes('mygateway/my-model'));
});

test('catalogRefs skips disabled models', () => {
  const refs = catalogRefs({
    providers: {
      mygateway: { protocol: 'openai', baseURL: 'https://gw.example.com/v1', models: { gone: { disabled: true } } },
    },
  });
  assert.ok(!refs.includes('mygateway/gone'));
});

test('formatModelHint: zh and en copy with suggestions and /model pointer', () => {
  const zh = formatModelHint('anthropic/claude-sonet-5-5', REFS, { lang: 'zh' });
  assert.match(zh.title, /claude-sonet-5-5/);
  assert.match(zh.body, /claude-sonnet-5-5/);
  assert.match(zh.body, /\/model/);
  assert.match(zh.line, /⚠/);

  const en = formatModelHint('anthropic/claude-sonet-5-5', REFS, { lang: 'en' });
  assert.match(en.title, /not in the known catalog/);
  assert.match(en.body, /claude-sonnet-5-5/);
  assert.match(en.body, /\/model/);

  // at most 5 suggestions
  assert.ok(!zh.body.includes('openai/o4-mini') || nearestRefs('anthropic/claude-sonet-5-5', REFS, 5).length <= 5);
  const many = formatModelHint('x/y', [...REFS, 'a/b1', 'a/b2', 'a/b3', 'a/b4', 'a/b5', 'a/b6'], { lang: 'en' });
  const suggested = many.body.split(': ')[1].split('. Switch')[0].split(', ');
  assert.ok(suggested.length <= 5);
});
