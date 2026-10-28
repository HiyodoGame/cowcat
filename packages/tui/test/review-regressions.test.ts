import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoxRenderable, ImageRenderable, TextRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { createChildGroup, mountScene } from '../src/ui/primitives.js';
import { imageBlock, textBlock } from '../src/ui/scene.js';
import { line } from '../src/ui/line.js';
import { THEME } from '../src/theme/tokens.js';
import { createScreen } from '../src/ui/screen.js';
import { frameOf } from '../src/components/session-frame.js';
import { initialView, openModelPanel, openProviderPanel, withModelList, withProviderList } from '../src/app/view.js';
import { project } from '../src/app/project.js';

const context = (renderer: Parameters<typeof mountScene>[0]['renderer']) => ({ renderer, theme: THEME, onHit: () => undefined });

test('keyed replacement preserves the requested child order', async () => {
  const { renderer, dispose } = await createTestRenderer({ width: 40, height: 8 });
  try {
    const parent = new BoxRenderable(renderer, { id: 'parent', width: 40, height: 8 });
    renderer.root.add(parent);
    const group = createChildGroup(context(renderer), parent);
    group.update([textBlock('a', [line('A')]), textBlock('b', [line('B')])]);
    group.update([textBlock('x', [line('X')]), textBlock('b', [line('B')])]);
    assert.deepEqual(parent.getChildren().map((child) => child.id), ['scene-text-x', 'scene-text-b']);
  } finally {
    await dispose();
  }
});

test('a same-key image can change A to B and back to A', async () => {
  const { renderer, dispose } = await createTestRenderer({ width: 8, height: 4 });
  try {
    const parent = new BoxRenderable(renderer, { id: 'parent', width: 8, height: 4 });
    renderer.root.add(parent);
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const binding = mountScene(context(renderer), parent, imageBlock('avatar', { source: a, label: 'a', cols: 2, rows: 2 }));
    binding.update(imageBlock('avatar', { source: b, label: 'b', cols: 2, rows: 2 }));
    binding.update(imageBlock('avatar', { source: a, label: 'a', cols: 2, rows: 2 }));
    const image = binding.renderable.findDescendantById('scene-image-avatar-image');
    assert.ok(image instanceof ImageRenderable);
    assert.equal(image.source, a);
  } finally {
    await dispose();
  }
});

test('full-width mode renders content beyond 100 columns', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 160, height: 18 });
  const previous = process.env.COWCAT_WIDTH;
  const sidebar = process.env.COWCAT_SIDEBAR;
  process.env.COWCAT_WIDTH = 'full';
  process.env.COWCAT_SIDEBAR = 'off';
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    const event: WireEvent = { seq: 1, ts: 0, sessionId: 's', turnId: 't', type: 'model.message', text: 'x'.repeat(130), toolCalls: [], reasoning: [] };
    screen.update(frameOf(project(initialView(), event), { width: screen.contentWidth(), now: 0 }));
    await renderOnce();
    assert.match(captureCharFrame(), new RegExp('x'.repeat(130)));
  } finally {
    if (previous === undefined) delete process.env.COWCAT_WIDTH;
    else process.env.COWCAT_WIDTH = previous;
    if (sidebar === undefined) delete process.env.COWCAT_SIDEBAR;
    else process.env.COWCAT_SIDEBAR = sidebar;
    await dispose();
  }
});

test('a long CJK approval keeps its suffix and all choices reachable', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 48, height: 16 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    let view = project(initialView(), { seq: 1, ts: 0, sessionId: 's', turnId: 't', type: 'turn.opened', input: 'run' });
    view = project(view, { seq: 2, ts: 0, sessionId: 's', turnId: 't', type: 'approval.requested', callId: 'c', name: 'Bash', rule: 'escalation', command: `${'删除'.repeat(60)}HARMFUL_SUFFIX`, reason: null, dimensions: [] });
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 0 }));
    await renderOnce();
    const tail = captureCharFrame();
    assert.match(tail, /HARMFUL_SUFFIX/);
    assert.match(tail, /允许一次/);
    assert.match(tail, /拒绝/);
    const subject = renderer.root.findDescendantById('scene-scrolltext-facts-content');
    assert.ok(subject instanceof TextRenderable);
    (subject as unknown as { onMouseEvent(event: { type: string; scroll: { direction: string; delta: number } }): void }).onMouseEvent({ type: 'scroll', scroll: { direction: 'up', delta: 100 } });
    assert.equal(subject.scrollY, 0);
    await renderOnce();
    assert.match(captureCharFrame(), /删除/);
  } finally {
    await dispose();
  }
});

test('ordinary long dialogs keep the selected final choice and footer visible', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, flush } = await createTestRenderer({ width: 60, height: 24 });
  try {
    const models = Array.from({ length: 9 }, (_, index) => ({ id: `provider/model-${String(index + 1)}`, efforts: [] }));
    const current = { id: 'provider/model-9', effort: null };
    const view = openModelPanel(withModelList(initialView(), models, current));
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 0 }));
    await renderOnce();
    await flush();
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /provider\/model-9/);
    assert.match(frame, /切换 enter/);
  } finally {
    await dispose();
  }
});

test('dialog connection and current marks remain as readable status text', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, flush } = await createTestRenderer({ width: 70, height: 24 });
  try {
    const view = openProviderPanel(withProviderList(initialView(), [{ name: 'deepseek', baseUrl: null, apiKeyEnv: 'KEY', keySet: true, custom: false, protocol: 'openai', complete: true, models: [] }]));
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 0 }));
    await renderOnce();
    await flush();
    await renderOnce();
    assert.match(captureCharFrame(), /deepseek.*当前/);
  } finally {
    await dispose();
  }
});
