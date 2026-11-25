import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameOf } from '../src/components/session-frame.js';
import { initialView, type TuiView } from '../src/app/view.js';

const task = { taskId: 'bg_1', callId: 'c1', command: 'npm test', startedAt: 0, startedSeq: 2, state: 'running' as const, endedAt: null, exitCode: null };

function dockKeys(view: TuiView, width: number): string[] {
  return (frameOf(view, { width, now: 1_000, height: 32, rails: false, activityRail: false }).dock ?? []).map((node) => node.key);
}

test('narrow layout shows the background-task panel once when /tasks is open', () => {
  const view: TuiView = { ...initialView(), tasks: [task], taskPanel: { index: 0 } };
  const keys = dockKeys(view, 100);
  assert.equal(keys.filter((key) => key === 'tasks').length, 1, `dock keys: ${keys.join(', ')}`);
});

test('narrow layout keeps the task list visible without /tasks open', () => {
  const view: TuiView = { ...initialView(), tasks: [task] };
  assert.equal(dockKeys(view, 100).filter((key) => key === 'tasks').length, 1);
});
