import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSelectionSummary, ModelSummary } from '@corescense/cowcat-protocol';
import { intentFor } from '../src/app/keymap.js';
import { closeModelPanel, enterModelPanel, initialView, moveModelPanel, openModelPanel, pickModelEffort, withModelList, withModelQuery } from '../src/app/view.js';
import { frameOf } from '../src/components/session-frame.js';
import { modelPanel } from '../src/components/model-panel.js';
import { nodesOf, textOf } from './scene.js';

const MODELS: readonly ModelSummary[] = [
  { id: 'openai/gpt-6.1-sol', efforts: ['low', 'medium', 'high'] },
  { id: 'anthropic/claude-sonnet-5-5', efforts: [] },
  { id: 'zai/glm-5.3-flash', efforts: ['high'] },
];
const CURRENT: ModelSelectionSummary = { id: 'zai/glm-5.3-flash', effort: 'high' };
function panelView() { return openModelPanel(withModelList(initialView(), MODELS, CURRENT)); }

test('model choices mark current presets and efforts through native selection', () => {
  const panel = modelPanel(MODELS, 0, CURRENT, null, 70);
  const text = textOf([panel]);
  assert.match(text, /zai\/glm-5\.3-flash（当前）/);
  assert.match(text, /effort: low\/medium\/high/);
  const first = nodesOf([panel]).find((node) => node.kind === 'choice');
  assert.equal(first?.kind === 'choice' && first.selected, true);
  const efforts = modelPanel(MODELS, 0, CURRENT, 'openai/gpt-6.1-sol', 70);
  assert.equal(efforts.kind === 'panel' && efforts.title, 'openai/gpt-6.1-sol · 选择推理力度');
  assert.doesNotMatch(textOf([efforts]), /claude-sonnet/);
  assert.match(textOf([modelPanel(MODELS, 0, CURRENT, 'zai/glm-5.3-flash', 70)]), /high（当前）/);
});

test('enter descends into efforts for a preset that has them, picks directly for one that does not', () => {
  let view = panelView();
  view = moveModelPanel(view, 1, view.modelList.length);
  const direct = enterModelPanel(view);
  assert.deepEqual(direct, { view: closeModelPanel(view), picked: 'anthropic/claude-sonnet-5-5' });
  const descend = enterModelPanel(panelView());
  assert.equal(descend.picked, null);
  assert.equal(descend.view.modelPanel?.preset, 'openai/gpt-6.1-sol');
  const picked = pickModelEffort(moveModelPanel(descend.view, 2, 3));
  assert.deepEqual(picked, { view: closeModelPanel(moveModelPanel(descend.view, 2, 3)), preset: 'openai/gpt-6.1-sol', effort: 'high' });
});

test('the dialog owns arrows and Esc and retains search and empty states', () => {
  const view = panelView();
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'modelMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'modelClose' });
  const dialog = frameOf(view, { width: 80, height: 24, now: 0 }).dialog;
  assert.equal(dialog?.title, '选择模型');
  assert.equal(dialog?.groups.flatMap((group) => group.rows).length, 3);
  const queried = frameOf(withModelQuery(view, 'glm'), { width: 80, height: 24, now: 0 }).dialog;
  assert.deepEqual(queried?.groups.flatMap((group) => group.rows).map((row) => row.label), ['zai/glm-5.3-flash']);
  assert.equal(queried?.query, 'glm');
  assert.equal(closeModelPanel(view).modelPanel, null);
  assert.match(textOf([modelPanel([], 0, null, null, 70)]), /先配置 model/);
});
