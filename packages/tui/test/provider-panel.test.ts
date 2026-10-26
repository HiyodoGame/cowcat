import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderSummary } from '@corescense/cowcat-protocol';
import { intentFor } from '../src/app/keymap.js';
import {
  beginProviderAdd,
  beginProviderEdit,
  closeProviderPanel,
  enterProviderPanel,
  initialView,
  moveProviderPanel,
  openProviderPanel,
  providerFieldCount,
  providerRowCount,
  withProviderList,
} from '../src/app/view.js';
import { findCommand } from '../src/app/commands.js';
import { frameOf } from '../src/components/session-frame.js';
import { providerFieldLines, providerPanelLines } from '../src/components/provider-panel.js';

const PROVIDERS: readonly ProviderSummary[] = [
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', keySet: true },
  { name: 'selfhost', baseUrl: null, apiKeyEnv: 'GW_KEY', keySet: false },
];

test('the provider panel lists entries with endpoint and key state, plus the add row (ADR-165 ③)', () => {
  const text = providerPanelLines(PROVIDERS, 0, 70).map((row) => row.text).join('\n');
  assert.match(text, /▸ deepseek — https:\/\/api\.deepseek\.com\/v1 · DEEPSEEK_API_KEY ✓/);
  assert.match(text, /selfhost — （内置端点） · GW_KEY ✗ 未设/);
  assert.match(text, /\+ 新增服务商…/);
  // The panel never asks for a secret: the env-name hint is the closest it gets.
  assert.doesNotMatch(text, /sk-/);
});

test('the field phase shows the two editable fields only; a new entry shows defaults', () => {
  const edit = providerFieldLines('deepseek', PROVIDERS[0], 0, 70).map((row) => row.text).join('\n');
  assert.match(edit, /编辑 deepseek/);
  assert.match(edit, /baseUrl: https:\/\/api\.deepseek\.com\/v1/);
  assert.match(edit, /apiKeyEnv: DEEPSEEK_API_KEY/);
  const fresh = providerFieldLines('', undefined, 0, 70).map((row) => row.text).join('\n');
  assert.match(fresh, /新增服务商/);
  assert.match(fresh, /面板不收 key/);
});

test('panel phases own arrows and Esc; Esc in the field menu backs out to the list', () => {
  let view = openProviderPanel(withProviderList(initialView(), PROVIDERS));
  assert.equal(providerRowCount(view), 3, 'two providers plus the add row');
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'providerMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'providerClose' });

  view = moveProviderPanel(view, 2, providerRowCount(view)); // the add row
  const menu = enterProviderPanel(view);
  assert.equal(menu.providerPanel?.entry, '');
  assert.equal(providerFieldCount(), 2);
  view = moveProviderPanel(menu, 1, providerFieldCount());
  view = beginProviderEdit(view, 1);
  assert.equal(view.providerEdit?.field, 'apiKeyEnv');

  // Esc in the field phase returns to the list, not out of the panel.
  const back = intentFor({ name: 'escape', ctrl: false }, view);
  assert.deepEqual(back, { kind: 'providerClose' });
  const listed = { ...view, providerPanel: { index: 0, entry: null } };
  assert.equal(closeProviderPanel(listed).providerPanel, null);
});

test('beginProviderAdd starts a name edit; enterProviderPanel resolves the row to its entry', () => {
  const add = beginProviderAdd(withProviderList(initialView(), PROVIDERS));
  const edit = add.providerEdit;
  assert.ok(edit !== null);
  assert.equal(edit.name, '');
  assert.equal(edit.field, 'name', 'the first edit of a new provider is its name');
  const view = enterProviderPanel(openProviderPanel(withProviderList(initialView(), PROVIDERS)));
  assert.equal(view.providerPanel?.entry, 'deepseek');
});

test('/providers and /effort are first-class command effects (ADR-165 ③)', () => {
  const providers = findCommand('providers');
  assert.ok(providers !== undefined);
  assert.equal(providers.run(initialView()).kind, 'providerPanel');
  const effort = findCommand('effort');
  assert.ok(effort !== undefined);
  assert.equal(effort.run(initialView()).kind, 'effortPanel');
});

test('the frame mounts the provider panel in the dock', () => {
  const view = openProviderPanel(withProviderList(initialView(), PROVIDERS));
  const dock = frameOf(view, { width: 90, height: 24, now: 0 }).dock ?? [];
  assert.match(dock.map((row) => row.text).join('\n'), /服务商（2）/);
});
