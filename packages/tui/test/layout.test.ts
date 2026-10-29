import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createScreen } from '../src/ui/screen.js';
import { THEME } from '../src/theme/tokens.js';
import { statusBar } from '../src/components/status-bar.js';
import { frameOf } from '../src/components/session-frame.js';
import { initialView } from '../src/app/view.js';
import { stringWidth } from '../src/text/width.js';

test('a medium terminal gives the reading column the space the old two-rail layout took', async () => {
  const { renderer, dispose } = await createTestRenderer({ width: 120, height: 32 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    assert.ok(screen.contentWidth() >= 80, `reading width was ${String(screen.contentWidth())}`);
    assert.equal(screen.activityRail(), false);
  } finally {
    await dispose();
  }
});

test('a wide terminal has an activity rail without making prose more than 100 columns', async () => {
  const { renderer, dispose } = await createTestRenderer({ width: 160, height: 36 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    assert.equal(screen.activityRail(), true);
    assert.ok(screen.contentWidth() <= 100);
  } finally {
    await dispose();
  }
});

test('status facts yield to the current activity instead of overflowing a narrow bar', () => {
  const status = statusBar({
    ...initialView(),
    model: 'provider/a-long-model-name',
    turn: { id: 't', state: 'streaming', reason: null, cronSourced: false },
    turnStartedAt: 0,
    todos: [{ content: 'work', status: 'in_progress', activeForm: 'working' }],
    usage: { input: 1_000, output: 200, cacheRead: 0, cacheCreation: 0 },
    usageTotals: { input: 10_000, output: 2_000, cacheRead: 0, cacheCreation: 0 },
    contextWindow: 100_000,
    price: { input: 1, output: 2 },
  }, { now: 12_000, width: 48 });
  const width = stringWidth(status.activity) + status.facts.reduce((sum, fact) => sum + stringWidth(` ${fact.label} ${fact.value} `) + 1, 0);
  assert.ok(width <= 48, `status content is ${String(width)} columns wide`);
});


test('a full terminal keeps fixed empty sections in order and preserves the reading column', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 160, height: 40 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(initialView(), { width: 160, height: 40, now: 0, cwd: 'F:/project' }));
    await renderOnce();
    const frame = captureCharFrame();
    assert.equal(screen.activityRail(), true);
    assert.ok(screen.contentWidth() >= 80);
    assert.ok(frame.indexOf('暂无待办') < frame.indexOf('暂无运行中的子代理'));
    assert.ok(frame.indexOf('暂无运行中的子代理') < frame.indexOf('暂无后台任务'));
    assert.match(frame, /暂无 CowCat 变更/);
    assert.doesNotMatch(frame, /奶牛猫\s*\//);
  } finally {
    await dispose();
  }
});

test('activity rails require both 160 columns and 32 rows while the info rail stays responsive', async () => {
  for (const [width, height, expected] of [[159, 40, false], [160, 31, false], [160, 32, true], [120, 32, false]] as const) {
    const { renderer, dispose } = await createTestRenderer({ width, height });
    try {
      const screen = createScreen(renderer, THEME, { title: 't' });
      assert.equal(screen.activityRail(), expected, `${String(width)}x${String(height)}`);
      if (width === 120) assert.equal(screen.wideRails(), true);
    } finally {
      await dispose();
    }
  }
});

test('overfull rail content is bounded with an overflow count instead of pushing the mascot out', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 160, height: 40 });
  try {
    const view = {
      ...initialView(),
      todosVisible: true,
      todos: Array.from({ length: 30 }, (_, index) => ({ content: `todo-${String(index)}`, status: 'pending', activeForm: '' })),
      tasks: Array.from({ length: 20 }, (_, index) => ({
        taskId: `bg-${String(index)}`, callId: `call-${String(index)}`, command: `task-${String(index)}`,
        startedAt: 0, startedSeq: index + 1, state: 'running' as const, endedAt: null, exitCode: null,
      })),
      agents: Array.from({ length: 20 }, (_, index) => ({
        childSessionId: `child-${String(index)}`, role: `agent-${String(index)}`, description: 'work',
        state: 'running' as const, turns: 1, startedAt: 0,
      })),
    };
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(view, { width: 160, height: 40, now: 0, cwd: 'F:/a/very/long/path/that/must/wrap' }));
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /另有 \d+ 项/);
    assert.doesNotMatch(frame, /task-19/);
    assert.ok(frame.split('\n').every((row) => stringWidth(row) <= 160));
  } finally {
    await dispose();
  }
});


test('the minimum full layout keeps all 23 mascot rows and hides both rails below 32 rows', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 160, height: 32 });
  try {
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(initialView(), { width: 160, height: 32, now: 0, cwd: 'F:/project' }));
    await renderOnce();
    assert.equal(captureCharFrame().split('\n').filter((row) => row.includes('▪')).length, 23);
    assert.equal(screen.wideRails(), true);
  } finally {
    await dispose();
  }

  const { renderer: shortRenderer, dispose: disposeShort } = await createTestRenderer({ width: 160, height: 31 });
  try {
    const screen = createScreen(shortRenderer, THEME, { title: 't' });
    assert.equal(screen.activityRail(), false);
    assert.equal(screen.wideRails(), false);
  } finally {
    await disposeShort();
  }
});

test('one long todo remains one item instead of becoming several overflow items', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 160, height: 40 });
  try {
    const view = { ...initialView(), todosVisible: true, todos: [{ content: 'x'.repeat(200), status: 'pending', activeForm: '' }] };
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(view, { width: 160, height: 40, now: 0, cwd: 'F:/project' }));
    await renderOnce();
    assert.doesNotMatch(captureCharFrame(), /另有 \d+ 项/);
  } finally {
    await dispose();
  }
});

test('more than ten changed files reports the exact hidden item count', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 160, height: 40 });
  try {
    const view = {
      ...initialView(),
      entries: Array.from({ length: 20 }, (_, index) => ({
        kind: 'tool' as const, seq: index + 1, callId: `call-${String(index)}`, name: 'Write', ok: true,
        output: '', truncation: null, attachments: [], path: `F:/project/file-${String(index)}.ts`,
      })),
      calls: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`call-${String(index)}`, { name: 'Write', input: { content: 'x' } }])),
    };
    const screen = createScreen(renderer, THEME, { title: 't' });
    screen.update(frameOf(view, { width: 160, height: 40, now: 0, cwd: 'F:/project' }));
    await renderOnce();
    assert.match(captureCharFrame(), /另有 10 项/);
  } finally {
    await dispose();
  }
});
