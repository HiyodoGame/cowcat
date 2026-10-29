import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { project } from '../src/app/project.js';
import { initialView, openModelPanel, withModelList } from '../src/app/view.js';
import { frameOf, titleOf } from '../src/components/session-frame.js';
import { THEME } from '../src/theme/tokens.js';
import { createScreen } from '../src/ui/screen.js';

let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1_000, sessionId: 'sess_wide', turnId: 'turn_1', type, ...body };
}

test('a medium terminal gives prose room while the info rail keeps full ids and paths', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, flush } = await createTestRenderer({ width: 120, height: 30 });
  try {
    const screen = createScreen(renderer, THEME, { title: titleOf('0.0.0-test') });
    const view = [event('session.opened', {}), event('turn.opened', { input: 'hi', model: 'zai/glm-5.3-flash' })].reduce(project, initialView());
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 1_000, cwd: 'F:\\demo', rails: true, activityRail: false }));
    await renderOnce();
    await flush();
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /sess_wide/);
    assert.match(frame, /F:\\demo/);
    assert.match(frame, /glm-5\.3-flash/);
    assert.equal(screen.activityRail(), false);
  } finally {
    await dispose();
  }
});

test('markdown still renders as styled content without drawing UI glyphs', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 100, height: 30 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    const view = project(initialView(), event('model.message', { text: '## 结论\n\n**旧包**能解析。\n\n- 第一条', toolCalls: [], reasoning: [], stopReason: null }));
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 1_000 }));
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /结论/);
    assert.match(frame, /旧包/);
    assert.match(frame, /• 第一条/);
    assert.doesNotMatch(frame, /## 结论|\*\*旧包\*\*|▌/);
  } finally {
    await dispose();
  }
});

test('the model dialog uses a native selected-row background and a text field', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose, flush } = await createTestRenderer({ width: 100, height: 30 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    const view = openModelPanel(withModelList(initialView(), [{ id: 'openai/gpt-6.1-sol', efforts: ['high'] }, { id: 'zai/glm-5.3-flash', efforts: [] }], { id: 'zai/glm-5.3-flash', effort: null }));
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 1_000 }));
    await renderOnce();
    await flush();
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /选择模型/);
    assert.match(frame, /输入以筛选/);
    assert.match(frame, /openai\/gpt-6\.1-sol/);
    assert.match(frame, /zai\/glm-5\.3-flash/);
    const blue = RGBA.fromHex('#4A9EDA').toInts().join(',');
    assert.ok(captureSpans().lines.flatMap((row) => row.spans).some((span) => span.bg.toInts().join(',') === blue));
  } finally {
    await dispose();
  }
});

test('the wide rail renders the cow-spotted cat, activities and themed panels', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose, flush } = await createTestRenderer({ width: 160, height: 36 });
  try {
    const theme = { ...THEME, foreground: { ...THEME.foreground, brand: '#010203', act: '#040506' } };
    const screen = createScreen(renderer, theme, { title: 't' });
    let view = [event('session.opened', {}), event('todo.updated', { todos: [{ content: '改代码', status: 'in_progress', activeForm: '在改代码' }] })].reduce(project, initialView());
    view = { ...view, tasks: [{ taskId: 't1', callId: 'c1', command: 'npm test', startedAt: 1_000, startedSeq: 3, state: 'running', endedAt: null, exitCode: null }] };
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 2_000, cwd: 'F:\\demo', rails: true, activityRail: true }));
    await renderOnce();
    await flush();
    await renderOnce();
    const frame = captureCharFrame();
    assert.doesNotMatch(frame, /奶牛猫\s*\//);
    assert.match(frame, /在改代码/);
    assert.match(frame, /npm test/);
    const spans = captureSpans().lines.flatMap((row) => row.spans);
    const backgrounds = spans.map((span) => span.bg.toInts().join(','));
    assert.ok(backgrounds.includes(RGBA.fromHex('#F7F5F0').toInts().join(',')), 'white fur');
    assert.ok(backgrounds.includes(RGBA.fromHex('#141419').toInts().join(',')), 'dark cow patches');
    assert.ok(backgrounds.includes(RGBA.fromHex('#E8A0A0').toInts().join(',')), 'pink nose');
    assert.ok(backgrounds.includes('1,2,3,255'), 'themed panel headers');
    assert.ok(spans.some((span) => span.fg.toInts().join(',') === '4,5,6,255'), 'active rows use the theme');
  } finally {
    await dispose();
  }
});

test('a short terminal keeps approval choices visible above the composer', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 64, height: 16 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    const view = [event('turn.opened', { input: '清一下构建目录' }), event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null })].reduce(project, initialView());
    screen.update(frameOf(view, { width: screen.contentWidth(), now: 1_000 }));
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /允许一次/);
    assert.match(frame, /本会话内 Bash 都不再问/);
  } finally {
    await dispose();
  }
});
