import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS } from '../src/host/presets.js';

const LEVELS = ['low', 'medium', 'high'] as const;

test('Anthropic presets declare thinking budgets within the documented bound (ADR-046 ④)', () => {
  for (const id of ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5']) {
    const preset = BUILTIN_PRESETS[id];
    assert.ok(preset !== undefined, `${id} exists`);
    const efforts = preset.efforts ?? {};
    assert.deepEqual(Object.keys(efforts), [...LEVELS]);
    const output = preset.limits.output ?? 0;
    assert.ok(output > 1024, `${id} declares an output limit larger than any budget`);
    for (const level of LEVELS) {
      const thinking = (efforts[level] as { thinking: { type?: string; budget_tokens?: number } }).thinking;
      assert.equal(thinking.type, 'enabled');
      const budget = thinking.budget_tokens ?? 0;
      assert.ok(budget >= 1024 && budget < output, `${id} ${level}: ${String(budget)} within [1024, ${String(output)})`);
    }
  }
});

test('DeepSeek presets declare reasoning_effort levels (research p4 B-4)', () => {
  const preset = BUILTIN_PRESETS['deepseek/deepseek-flash'];
  assert.ok(preset !== undefined);
  const efforts = preset.efforts ?? {};
  assert.deepEqual(Object.keys(efforts), [...LEVELS]);
  for (const level of LEVELS) assert.deepEqual(efforts[level], { reasoning_effort: level });
});

test('providers without upstream evidence declare no efforts rather than guessing', () => {
  for (const id of ['zai/glm-5.3', 'moonshotai/kimi-k3', 'openai/gpt-6.1-sol']) {
    assert.equal(BUILTIN_PRESETS[id]?.efforts, undefined, `${id} stays undeclared until its extension is verified`);
  }
});
