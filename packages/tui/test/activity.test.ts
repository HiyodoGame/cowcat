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
  assert.equal(activityDelay(initialView(), 1_000, true, true), 400);
  assert.equal(activityDelay(initialView(), 4_000, true, true), 200);
  assert.equal(activityDelay(initialView(), 4_100, true, true), 100);
  assert.equal(activityDelay(initialView(), 4_200, true, true), 1_000);
});

test('idle schedules breathing, gaze and blink transitions without external redraws', () => {
  assert.equal(activityDelay(initialView(), 0, true, true), 1_400);
  assert.equal(activityDelay(initialView(), 1_399, true, true), 1);
  assert.equal(activityDelay(initialView(), 1_400, true, true), 1_400);
  assert.equal(activityDelay(initialView(), 2_800, true, true), 1_200);
  assert.equal(activityDelay(initialView(), 5_200, true, true), 400);
  assert.equal(activityDelay(initialView(), 5_600, true, true), 400);
  assert.equal(activityDelay(initialView(), 6_000, true, true), 1_000);
});

test('thinking and tools schedule the phases their pixels actually use', () => {
  const thinking = { ...initialView(), turn: { id: 't', state: 'streaming', reason: null, cronSourced: false } };
  assert.equal(activityDelay(thinking, 0, true, true), 600);
  const tools = { ...initialView(), tasks: [{ taskId: 't', callId: 'c', command: 'npm test', startedAt: 0, startedSeq: 1, state: 'running' as const, endedAt: null, exitCode: null }] };
  assert.equal(activityDelay(tools, 0, true, true), 240);
});


test('success pulses once while failed waits only for the settled feedback window', () => {
  const success = { ...initialView(), turn: { id: 't', state: 'completed' as const, reason: null, cronSourced: false }, turnSettledAt: 0 };
  assert.equal(activityDelay(success, 0, true, true), 400);
  assert.equal(activityDelay(success, 500, true, true), 300);

  const failed = { ...initialView(), turn: { id: 't', state: 'failed' as const, reason: 'x', cronSourced: false }, turnSettledAt: 0 };
  assert.equal(activityDelay(failed, 0, true, true), 1_600);
  assert.equal(activityDelay(failed, 500, true, true), 1_100);
  assert.equal(activityDelay(failed, 1_599, true, true), 1);
});
