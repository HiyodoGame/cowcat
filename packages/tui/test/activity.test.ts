import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityDelay } from '../src/app/activity.js';
import { initialView } from '../src/app/view.js';

test('reasoning advances on narrow terminals and reveals without a mascot rail', () => {
  const view = { ...initialView(), reasoningStream: '思考内容', reasoningShown: 0 };
  assert.equal(activityDelay(view, 1_000, false, true), 200);
  assert.equal(activityDelay({ ...view, reasoningShown: 4 }, 1_000, false, true), null);
});

test('reduced motion never schedules visual animation', () => {
  const view = { ...initialView(), reasoningStream: '思考内容', reasoningShown: 0 };
  assert.equal(activityDelay(view, 1_000, true, false), null);
});

test('primary turns and background-only work reschedule immediately at 200ms', () => {
  const primary = { ...initialView(), turn: { id: 't', state: 'streaming', reason: null, cronSourced: false } };
  assert.equal(activityDelay(primary, 1_000, true, true), 200);
  const background = { ...initialView(), tasks: [{ taskId: 't', callId: 'c', command: 'npm test', startedAt: 0, startedSeq: 1, state: 'running' as const, endedAt: null, exitCode: null }] };
  assert.equal(activityDelay(background, 1_000, true, true), 200);
});

test('idle blink schedules its exact opening and closing deadlines', () => {
  assert.equal(activityDelay(initialView(), 1_000, true, true), 3_000);
  assert.equal(activityDelay(initialView(), 4_000, true, true), 200);
  assert.equal(activityDelay(initialView(), 4_100, true, true), 100);
  assert.equal(activityDelay(initialView(), 4_200, true, true), 4_000);
});
