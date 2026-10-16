import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, IllegalTransitionError, isTerminal, type TurnState } from '../src/kernel/turn.js';

const ALL: TurnState[] = [
  'idle', 'requesting', 'streaming', 'awaiting_tools', 'awaiting_approval',
  'finishing', 'completed', 'cancelled', 'failed',
];

test('terminal states have no outgoing transitions', () => {
  for (const from of ALL.filter(isTerminal)) {
    for (const to of ALL) assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  }
});

test('a finished turn cannot skip back into the loop', () => {
  assert.equal(canTransition('finishing', 'requesting'), false);
  assert.equal(canTransition('streaming', 'completed'), false, 'completion goes through finishing');
});

test('every non-terminal state can be cancelled or failed', () => {
  for (const from of ALL.filter((s) => !isTerminal(s) && s !== 'idle')) {
    assert.equal(canTransition(from, 'cancelled'), true, `${from} -> cancelled`);
    assert.equal(canTransition(from, 'failed'), true, `${from} -> failed`);
  }
});

test('IllegalTransitionError carries both endpoints', () => {
  const err = new IllegalTransitionError('idle', 'completed');
  assert.equal(err.from, 'idle');
  assert.equal(err.to, 'completed');
  assert.match(err.message, /idle -> completed/);
});
