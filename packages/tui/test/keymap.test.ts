import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intentFor } from '../src/app/keymap.js';
import { initialView, type TuiView } from '../src/app/view.js';

/**
 * The keymap is a table of assertions, not a switch buried in the loop — a key that stops
 * working is otherwise only discovered by a user. These are the ones that changed when the
 * approval card grew rows.
 */
function withApproval(): TuiView {
  return {
    ...initialView(),
    approval: {
      callId: 'c1',
      name: 'Bash',
      rule: 'no-rule-matched',
      reason: null,
      warning: null,
      askedAt: 0,
      verdict: null,
      by: null,
    },
  };
}

test('Ctrl-T toggles thinking', () => {
  assert.deepEqual(intentFor({ name: 't', ctrl: true }, initialView()), { kind: 'toggleThinking' });
});

test('arrows move the approval highlight only while a question is open', () => {
  assert.deepEqual(intentFor({ name: 'up', ctrl: false }, withApproval()), { kind: 'approvalMove', delta: -1 });
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, withApproval()), { kind: 'approvalMove', delta: 1 });
  // No question: the input widget keeps its arrow keys (history, cursor).
  assert.equal(intentFor({ name: 'up', ctrl: false }, initialView()), null);
});

test('the / menu owns arrows, Tab and Escape while it is open', () => {
  const view: TuiView = { ...initialView(), input: '/th' };
  assert.deepEqual(intentFor({ name: 'up', ctrl: false }, view), { kind: 'slashMove', delta: -1 });
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'slashMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'tab', ctrl: false }, view), { kind: 'slashAccept' });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'slashClose' });
  // A space means a prompt, not a menu.
  assert.equal(intentFor({ name: 'up', ctrl: false }, { ...view, input: '/help me' }), null);
});

test('paging scrolls the transcript', () => {
  assert.deepEqual(intentFor({ name: 'pageup', ctrl: false }, initialView()), { kind: 'scroll', delta: 10 });
  assert.deepEqual(intentFor({ name: 'pagedown', ctrl: false }, initialView()), { kind: 'scroll', delta: -10 });
});

test('an answered question hands the arrows back', () => {
  const view = withApproval();
  const approval = view.approval;
  assert.ok(approval !== null);
  const answered: TuiView = { ...view, approval: { ...approval, verdict: 'once', by: 'user' } };
  assert.equal(intentFor({ name: 'down', ctrl: false }, answered), null);
});
