import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { project } from '../src/app/project.js';
import { initialView } from '../src/app/view.js';
import { frameOf, titleOf } from '../src/components/session-frame.js';
import { THEME } from '../src/theme/tokens.js';
import { createScreen } from '../src/ui/screen.js';

/**
 * ADR-162/163's mount-side proof: a WIDE terminal actually shows the aside, and markdown
 * reaches the glass as styled text (markers gone). The narrow snapshots in frame.test.ts
 * pin the classic layout byte-for-byte; this file pins the two things those frames can
 * never show, by asserting the rendered characters instead of whole frames.
 */

let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1_000, sessionId: 'sess_wide', turnId: 'turn_1', type, ...body };
}

async function renderAt(width: number, height: number, events: readonly WireEvent[], cwd: string | undefined): Promise<string> {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width, height });
  try {
    const screen = createScreen(renderer, THEME, { title: titleOf('0.0.0-test') });
    const view = events.reduce(project, initialView());
    screen.update(frameOf(view, { width: screen.contentWidth(), height: screen.contentHeight(), now: 1_000, ...(cwd === undefined ? {} : { cwd }) }));
    await renderOnce();
    return captureCharFrame();
  } finally {
    await dispose();
  }
}

test('a 132-column terminal shows the session aside with workspace facts (ADR-163)', async () => {
  const frame = await renderAt(
    132,
    32,
    [
      event('session.opened', {}),
      event('turn.opened', { input: 'hi', model: 'zai/glm-5.3-flash' }),
      event('model.usage', { input: 500, output: 200, cacheRead: 0, cacheCreation: 0 }),
    ],
    'F:\\demo',
  );
  assert.match(frame, /会话/);
  assert.match(frame, /sess_wide/);
  assert.match(frame, /模型/);
  assert.match(frame, /glm-5\.3-flash/);
  assert.match(frame, /目录/);
  assert.match(frame, /F:\\demo/);
});

test('markdown reaches the glass without its markers (ADR-162)', async () => {
  const frame = await renderAt(
    100,
    30,
    [
      event('session.opened', {}),
      event('model.message', {
        text: '## 结论\n\n**旧包**能解析，分层图标报"图标为空"。\n\n- 第一条\n- 第二条',
        toolCalls: [],
        reasoning: [],
        stopReason: { kind: 'end' },
      }),
    ],
    undefined,
  );
  assert.match(frame, /结论/);
  assert.doesNotMatch(frame, /## 结论/);
  assert.doesNotMatch(frame, /\*\*旧包\*\*/);
  assert.match(frame, /旧包/);
  assert.match(frame, /• 第一条/);
});

test('a modal dialog renders as a centred floating window with a highlighted row (ADR-166)', async () => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { frameOf } = await import('../src/components/session-frame.js');
  const { THEME } = await import('../src/theme/tokens.js');
  const { createScreen } = await import('../src/ui/screen.js');
  const { withModelList, openModelPanel, initialView } = await import('../src/app/view.js');
  const { renderer, renderOnce, captureCharFrame, dispose, flush } = await createTestRenderer({ width: 100, height: 30 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    const view = openModelPanel(withModelList(initialView(), [
      { id: 'openai/gpt-6.1-sol', efforts: ['high'] },
      { id: 'zai/glm-5.3-flash', efforts: [] },
    ], { id: 'zai/glm-5.3-flash', effort: null }));
    screen.update(frameOf(view, { width: screen.contentWidth(), height: screen.contentHeight(), now: 1_000, cwd: 'F:\\d' }));
    await renderOnce();
    // The overlay flips `visible` on first mount; give the renderer a full cycle to lay
    // the newly-visible subtree out before capturing.
    await flush();
    await renderOnce();
    const frame = captureCharFrame();
    // The floating window: title, search field, both models, the footer.
    assert.match(frame, /选择模型/);
    assert.match(frame, /▏/);
    assert.match(frame, /openai\/gpt-6\.1-sol/);
    assert.match(frame, /zai\/glm-5\.3-flash/);
    assert.match(frame, /切换 enter/);
  } finally {
    await dispose();
  }
});
