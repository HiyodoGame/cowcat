import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSelectionSummary, ModelSummary } from '@corescense/cowcat-protocol';
import { intentFor } from '../src/app/keymap.js';
import {
  closeModelPanel,
  enterModelPanel,
  initialView,
  moveModelPanel,
  openModelPanel,
  pickModelEffort,
  withModelList,
} from '../src/app/view.js';
import { frameOf } from '../src/components/session-frame.js';
import { modelPanelLines } from '../src/components/model-panel.js';

const MODELS: readonly ModelSummary[] = [
  { id: 'openai/gpt-6.1-sol', efforts: ['low', 'medium', 'high'] },
  { id: 'anthropic/claude-sonnet-5-5', efforts: [] },
  { id: 'zai/glm-5.3-flash', efforts: ['high'] },
];
const CURRENT: ModelSelectionSummary = { id: 'zai/glm-5.3-flash', effort: 'high' };

function panelView() {
  return openModelPanel(withModelList(initialView(), MODELS, CURRENT));
}

test('the model picker lists presets, marks the current one, and shows efforts (ADR-161 ②)', () => {
  const text = modelPanelLines(MODELS, 0, CURRENT, null, 70).map((row) => row.text).join('\n');
  assert.match(text, /▸ openai\/gpt-6\.1-sol/);
  assert.match(text, /（当前） zai\/glm-5\.3-flash|zai\/glm-5\.3-flash（当前）|glm-5\.3-flash（当前）/);
  assert.match(text, /effort: low\/medium\/high/);
});

test('phase two lists only the locked preset efforts and marks the current pairing', () => {
  const text = modelPanelLines(MODELS, 0, CURRENT, 'openai/gpt-6.1-sol', 70).map((row) => row.text).join('\n');
  assert.match(text, /gpt-6\.1-sol · 选择推理力度/);
  assert.doesNotMatch(text, /claude-sonnet/);
  const current = modelPanelLines(MODELS, 0, CURRENT, 'zai/glm-5.3-flash', 70).map((row) => row.text).join('\n');
  assert.match(current, /high（当前）/);
});

test('enter descends into efforts for a preset that has them, picks directly for one that does not', () => {
  let view = panelView();
  view = moveModelPanel(view, 1, view.modelList.length); // claude-sonnet-5-5, no efforts
  const direct = enterModelPanel(view);
  assert.deepEqual(direct, { view: closeModelPanel(view), picked: 'anthropic/claude-sonnet-5-5' });

  const descend = enterModelPanel(panelView()); // gpt-6.1-sol, has efforts
  assert.equal(descend.picked, null);
  const panel = descend.view.modelPanel;
  assert.ok(panel !== null);
  assert.equal(panel.preset, 'openai/gpt-6.1-sol');
  assert.equal(panel.index, 0);
});

test('pickModelEffort resolves the highlighted effort and closes the panel', () => {
  const descended = enterModelPanel(panelView()).view;
  const moved = moveModelPanel(descended, 2, 3); // high
  const picked = pickModelEffort(moved);
  assert.deepEqual(picked, { view: closeModelPanel(moved), preset: 'openai/gpt-6.1-sol', effort: 'high' });
});

test('the panel owns arrows and Esc while open; the frame mounts it in the dock', () => {
  const view = panelView();
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'modelMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'modelClose' });
  const dock = frameOf(view, { width: 80, height: 24, now: 0 }).dock ?? [];
  assert.match(dock.map((row) => row.text).join('\n'), /模型（3） · ↑↓ 选择/);
  assert.equal(closeModelPanel(view).modelPanel, null);
});

test('an empty list renders the configure hint instead of an empty box', () => {
  const text = modelPanelLines([], 0, null, null, 70)[0]?.text ?? '';
  assert.match(text, /先配置 model/);
});
