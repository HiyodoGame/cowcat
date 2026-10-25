import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { project } from '../src/app/project.js';
import { closeHistorySearch, historyMatches, initialView, openHistorySearch, withInput, type TuiView } from '../src/app/view.js';

test('turn.opened rebuilds input history for reverse search', () => {
  const events: WireEvent[] = [
    { seq: 1, ts: 1, sessionId: 'sess_history', turnId: null, type: 'session.opened' },
    { seq: 2, ts: 1, sessionId: 'sess_history', turnId: 'turn_1', type: 'turn.opened', input: 'fix the parser' },
    { seq: 3, ts: 1, sessionId: 'sess_history', turnId: 'turn_2', type: 'turn.opened', input: 'run tests' },
  ];
  const view = events.reduce(project, initialView());
  assert.deepEqual(view.history, ['fix the parser', 'run tests']);
});

test('history search filters, preserves the draft, and restores a selection', () => {
  let view: TuiView = {
    ...initialView(),
    input: 'draft',
    history: ['fix parser', 'run tests', 'Fix docs'],
  };
  view = openHistorySearch(view);
  view = withInput(view, 'fix');
  assert.deepEqual(historyMatches(view), ['fix parser', 'Fix docs']);
  assert.equal(view.input, 'fix');
  const selected = historyMatches(view)[0] ?? 'missing';
  const restored = { ...closeHistorySearch(view), input: selected };
  assert.equal(restored.input, 'fix parser');
  const cancelled = closeHistorySearch(view);
  assert.equal(cancelled.input, 'draft');
});
