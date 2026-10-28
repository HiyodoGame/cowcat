import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderSummary } from '@corescense/cowcat-protocol';
import { intentFor } from '../src/app/keymap.js';
import { beginProviderAdd, beginProviderEdit, closeProviderPanel, enterProviderPanel, initialView, moveProviderPanel, openProviderPanel, providerFieldCount, providerRowCount, withProviderList, withProviderQuery } from '../src/app/view.js';
import { findCommand } from '../src/app/commands.js';
import { frameOf } from '../src/components/session-frame.js';
import { providerFields, providerPanel } from '../src/components/provider-panel.js';
import { textOf } from './scene.js';

const PROVIDERS: readonly ProviderSummary[] = [
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', keySet: true, custom: false, protocol: 'openai', complete: true, models: [] },
  { name: 'selfhost', baseUrl: null, apiKeyEnv: 'GW_KEY', keySet: false, custom: true, protocol: 'openai', complete: false, models: [] },
];

test('provider choices include endpoint and key state, never a secret', () => {
  const text = textOf([providerPanel(PROVIDERS, 0, 70)]);
  assert.match(text, /deepseek · https:\/\/api\.deepseek\.com\/v1 · DEEPSEEK_API_KEY 已设置/);
  assert.match(text, /selfhost · 内置端点 · GW_KEY 未设置/);
  assert.match(text, /新增服务商/);
  assert.doesNotMatch(text, /sk-/);
  const edit = providerFields('deepseek', PROVIDERS[0], 0, 70);
  assert.equal(edit.kind === 'panel' && edit.title, '编辑 deepseek');
  assert.match(textOf([edit]), /apiKeyEnv: DEEPSEEK_API_KEY/);
  assert.match(textOf([providerFields('', undefined, 0, 70)]), /面板不收 key/);
});

test('panel phases own arrows and Esc; fields only edit names of environment variables', () => {
  let view = openProviderPanel(withProviderList(initialView(), PROVIDERS));
  assert.equal(providerRowCount(view), 3);
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'providerMove', delta: 1 });
  view = moveProviderPanel(view, 2, providerRowCount(view));
  const menu = enterProviderPanel(view);
  assert.equal(menu.providerPanel?.entry, '');
  assert.equal(providerFieldCount(), 2);
  view = beginProviderEdit(moveProviderPanel(menu, 1, providerFieldCount()), 1);
  assert.equal(view.providerEdit?.field, 'apiKeyEnv');
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'providerClose' });
  assert.equal(closeProviderPanel({ ...view, providerPanel: { index: 0, entry: null, query: '' } }).providerPanel, null);
  const add = beginProviderAdd(withProviderList(initialView(), PROVIDERS));
  assert.equal(add.providerEdit?.field, 'name');
  assert.equal(enterProviderPanel(openProviderPanel(withProviderList(initialView(), PROVIDERS))).providerPanel?.entry, 'deepseek');
});

test('provider commands open a real dialog spec', () => {
  assert.equal(findCommand('providers')?.run(initialView()).kind, 'providerPanel');
  assert.equal(findCommand('effort')?.run(initialView()).kind, 'effortPanel');
  const dialog = frameOf(openProviderPanel(withProviderList(initialView(), PROVIDERS)), { width: 90, height: 24, now: 0 }).dialog;
  assert.equal(dialog?.title, '服务');
  assert.deepEqual(dialog?.groups[0]?.rows.map((row) => row.label), ['deepseek', 'selfhost']);
  assert.equal(dialog?.groups[0]?.rows[0]?.mark, '✓');
  assert.equal(dialog?.groups[0]?.rows[1]?.mark, undefined);
});

test('Enter edits the visible filtered provider and changing the query resets the cursor', () => {
  const moved = moveProviderPanel(openProviderPanel(withProviderList(initialView(), PROVIDERS)), 1, 3);
  const queried = withProviderQuery(moved, 'selfhost');
  assert.equal(queried.providerPanel?.index, 0);
  assert.equal(providerRowCount(queried), 2);
  assert.equal(enterProviderPanel(queried).providerPanel?.entry, 'selfhost');
});
