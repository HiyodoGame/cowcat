import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createScreen } from '../src/ui/screen.js';
import { THEME } from '../src/theme/tokens.js';
import { statusBar } from '../src/components/status-bar.js';
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
