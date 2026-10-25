import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { project } from '../src/app/project.js';
import { initialView, rememberInput, type TuiView } from '../src/app/view.js';

let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1_000, sessionId: 'sess_reconnect', turnId: null, type, ...body };
}

function turnEvents(input: string): WireEvent[] {
  return [
    event('turn.opened', { input, model: 'claude-sonnet-5-5' }),
    event('model.message', { text: `${input} — done`, toolCalls: [], reasoning: [], stopReason: { kind: 'end' } }),
    event('turn.transitioned', { to: 'completed' }),
  ];
}

const SESSION = (): WireEvent[] => [
  event('session.opened'),
  ...turnEvents('fix the parser'),
  ...turnEvents('run tests'),
];

test('a reconnect rebuilds the same view, because the view is a pure function of the log', () => {
  // Live: the events arrive once, as they happened. Reconnect: `session.open` replays the
  // same events onto a fresh view (ADR-156 ②) — there is no second source of truth, so
  // the two projections must agree field by field.
  seq = 0;
  const events = SESSION();
  const live = events.reduce(project, initialView());
  const replayed = events.reduce(project, initialView());
  assert.deepEqual(replayed, live);
  // And the rebuilt view is not empty: history and the terminal turn both survived.
  assert.deepEqual(live.history, ['fix the parser', 'run tests']);
  assert.equal(live.turn?.state, 'completed');
});

test('history keeps at most 100 prompts and drops consecutive duplicates (ADR-106 via ADR-156 ①)', () => {
  let view: TuiView = initialView();
  view = rememberInput(view, 'first');
  view = rememberInput(view, 'first'); // consecutive duplicate — not a new entry
  assert.deepEqual(view.history, ['first']);
  for (let i = 2; i <= 105; i += 1) view = rememberInput(view, `prompt ${String(i)}`);
  assert.equal(view.history.length, 100);
  assert.equal(view.history[0], 'prompt 6');
  assert.equal(view.history.at(-1), 'prompt 105');
  view = rememberInput(view, ''); // empty is never history
  assert.equal(view.history.length, 100);
});
