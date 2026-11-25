import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderSummary } from '@corescense/cowcat-protocol';
import { advanceProviderForm, beginProviderForm, providerFormConfiguration, type ProviderForm } from '../src/app/provider-form.js';
import type { TuiView } from '../src/app/view.js';
import { providerFormDialog } from '../src/components/provider-form.js';
import { initialView, openProviderPanel, withProviderList, withProviderQuery } from '../src/app/view.js';

const ZAI: ProviderSummary = {
  name: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', keySet: true,
  custom: false, protocol: 'openai', complete: true,
  models: [{ id: 'zai/glm-5.3-flash', protocol: 'openai', model: 'glm-5.3-flash', limits: { context: 1000000, output: 131072 }, toolCalls: true, contextWindow: 1000000, outputLimit: 131072 }],
};

function setup() {
  return beginProviderForm(openProviderPanel(withProviderList(initialView(), [ZAI])), true);
}

function formOf(view: TuiView): ProviderForm {
  const form = view.providerForm;
  if (form === null) throw new Error('expected a provider form');
  return form;
}

test('a built-in wizard selects a real model and confirms endpoint and key reference', () => {
  let view = setup();
  assert.equal(view.providerForm?.step, 'template');
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'model');
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'baseUrl');
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'apiKey');
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'apiKeyEnv');
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'review');
  assert.deepEqual(providerFormConfiguration(formOf(view)), {
    name: 'zai', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY',
    preset: 'zai/glm-5.3-flash', activate: true,
  });
  const dialog = providerFormDialog(formOf(view));
  assert.equal(dialog.groups.flatMap((group) => group.rows).some((row) => row.label === '保存并应用'), true);
});

test('a custom wizard collects every field required for a callable model', () => {
  let view = setup();
  const form = formOf(view);
  view = { ...view, providerForm: { ...form, index: form.templates.length - 2 } };
  view = advanceProviderForm(view);
  for (const [step, value, next] of [
    ['name', 'local', 'baseUrl'],
    ['baseUrl', 'http://localhost:11434/v1', 'apiKey'],
    ['apiKey', '', 'apiKeyEnv'],
    ['apiKeyEnv', 'LOCAL_API_KEY', 'modelId'],
    ['modelId', 'qwen3-coder', 'context'],
    ['context', '128000', 'output'],
    ['output', '8192', 'toolCalls'],
  ] as const) {
    assert.equal(view.providerForm?.step, step);
    view = advanceProviderForm({ ...view, providerForm: { ...formOf(view), value } });
    assert.equal(view.providerForm?.step, next);
  }
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'review');
  assert.deepEqual(providerFormConfiguration(formOf(view)), {
    name: 'local', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'LOCAL_API_KEY',
    preset: 'local/qwen3-coder', activate: true,
    definition: { protocol: 'openai', model: 'qwen3-coder', limits: { context: 128000, output: 8192 }, toolCalls: true },
  });
});

test('built-in limits are shown in the review instead of being reported as undeclared', () => {
  const view = setup();
  assert.equal(view.providerForm?.context, '1000000');
  assert.equal(view.providerForm?.output, '131072');
});

test('editing after filtering starts with the provider visible to the user', () => {
  const other = { ...ZAI, name: 'alpha', custom: true };
  const filtered = withProviderQuery(openProviderPanel(withProviderList(initialView(), [other, ZAI])), 'zai');
  const view = advanceProviderForm(beginProviderForm(filtered));
  assert.equal(view.providerForm?.name, 'zai');
});

test('the API key step takes a pasted key masked, and the name step refuses one without echo', () => {
  let view = setup();
  view = advanceProviderForm(view);
  view = advanceProviderForm(view);
  view = advanceProviderForm(view);
  assert.equal(view.providerForm?.step, 'apiKey');
  const pasted = 'sk-test-0123456789abcdef';
  view = advanceProviderForm({ ...view, providerForm: { ...formOf(view), value: 'sk-test 0123' } });
  assert.equal(view.providerForm?.step, 'apiKey', 'a key with a space is not accepted');
  assert.equal((formOf(view).error ?? '').includes('sk-test'), false, 'the rejected text is not echoed');
  view = advanceProviderForm({ ...view, providerForm: { ...formOf(view), value: pasted } });
  assert.equal(view.providerForm?.step, 'apiKeyEnv');
  assert.equal(formOf(view).apiKey, pasted, 'the key is kept in the form for saving');
  assert.equal(formOf(view).value, formOf(view).apiKeyEnv, 'the env name step is prefilled with the template default');
  // A key pasted into the name step is refused, and not echoed.
  view = advanceProviderForm({ ...view, providerForm: { ...formOf(view), value: pasted } });
  assert.equal(view.providerForm?.step, 'apiKeyEnv', 'the name step does not advance on a key value');
  assert.match(formOf(view).error ?? '', /环境变量名/);
  assert.equal((formOf(view).error ?? '').includes(pasted), false, 'the rejected value is not echoed back');
  view = advanceProviderForm({ ...view, providerForm: { ...formOf(view), value: 'DEEPSEEK_API_KEY' } });
  assert.equal(view.providerForm?.step, 'review');
});

test('the secret is masked in the dialog input and shows only its last four characters', async () => {
  const { maskSecret, providerFormDialog } = await import('../src/components/provider-form.js');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('abc'), '•••', 'short input reveals nothing');
  const masked = maskSecret('sk-0123456789abcdef');
  assert.equal(masked.endsWith('cdef'), true);
  assert.equal(masked.includes('0123456789ab'), false);
  let view = setup();
  for (let step = 0; step < 3; step += 1) view = advanceProviderForm(view);
  view = advanceProviderForm({ ...view, providerForm: { ...formOf(view), value: 'sk-0123456789abcdef' } });
  view = { ...view, providerForm: { ...formOf(view), step: 'apiKey', value: 'sk-0123456789abcdef' } };
  const dialog = providerFormDialog(formOf(view));
  assert.equal(dialog.input?.value.includes('sk-0123'), false, 'the dialog never renders the key prefix');
  assert.equal(dialog.input?.value.endsWith('cdef'), true);
});
