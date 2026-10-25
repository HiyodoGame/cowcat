import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intentFor } from '../src/app/keymap.js';
import { closeSlashMenu, initialView, type TuiView } from '../src/app/view.js';
import { findCommand, KEYS_HELP } from '../src/app/commands.js';

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
      command: null,
      path: null,
      dimensions: [],
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
  // No question and a non-empty draft: the input widget keeps its arrow keys.
  assert.equal(intentFor({ name: 'up', ctrl: false }, { ...initialView(), input: 'draft' }), null);
});

test('the task panel owns arrows, x and Escape while it is open (ADR-113)', () => {
  const view: TuiView = {
    ...initialView(),
    tasks: [
      {
        taskId: 'bg_a_1',
        callId: 'c1',
        command: 'pnpm dev',
        startedAt: 0,
        startedSeq: 2,
        state: 'running',
        endedAt: null,
        exitCode: null,
      },
    ],
    taskPanel: { index: 0 },
  };
  assert.deepEqual(intentFor({ name: 'up', ctrl: false }, view), { kind: 'taskMove', delta: -1 });
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'taskMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'x', ctrl: false }, view), { kind: 'taskStop' });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'tasksClose' });
  // Closed panel: `x` belongs to the input again.
  assert.equal(intentFor({ name: 'x', ctrl: false }, initialView()), null);
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

test('Ctrl+End jumps back to the tail', () => {
  assert.deepEqual(intentFor({ name: 'end', ctrl: true }, initialView()), { kind: 'scrollBottom' });
});

test('paging scrolls the transcript', () => {
  assert.deepEqual(intentFor({ name: 'pageup', ctrl: false }, initialView()), { kind: 'scroll', delta: 10 });
  assert.deepEqual(intentFor({ name: 'pagedown', ctrl: false }, initialView()), { kind: 'scroll', delta: -10 });
});

test('an answered question hands empty-input arrows back to scrolling', () => {
  const view = withApproval();
  const approval = view.approval;
  assert.ok(approval !== null);
  const answered: TuiView = { ...view, approval: { ...approval, verdict: 'once', by: 'user' } };
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, answered), { kind: 'scroll', delta: -1 });
});

test('Ctrl+C cancels a running turn instead of quitting', () => {
  const view: TuiView = { ...initialView(), turn: { id: 'turn_1', state: 'streaming', reason: null, cronSourced: false } };
  assert.deepEqual(intentFor({ name: 'c', ctrl: true }, view, 1_000, 0), { kind: 'cancel' });
});

test('Ctrl+C clears a draft and arms a second-press exit for an empty prompt', () => {
  assert.deepEqual(intentFor({ name: 'c', ctrl: true }, { ...initialView(), input: 'draft' }, 1_000, 0), { kind: 'clearInput' });
  assert.deepEqual(intentFor({ name: 'c', ctrl: true }, initialView(), 1_000, 0), { kind: 'armExit' });
  assert.deepEqual(intentFor({ name: 'c', ctrl: true }, initialView(), 1_500, 1_800), { kind: 'quit' });
  assert.deepEqual(intentFor({ name: 'c', ctrl: true }, initialView(), 1_801, 1_800), { kind: 'armExit' });
});

test('Ctrl+D exits only with an empty prompt', () => {
  assert.deepEqual(intentFor({ name: 'd', ctrl: true }, initialView()), { kind: 'quit' });
  assert.equal(intentFor({ name: 'd', ctrl: true }, { ...initialView(), input: 'draft' }), null);
});

test('plain arrows scroll only when the prompt is empty', () => {
  assert.deepEqual(intentFor({ name: 'up', ctrl: false }, initialView()), { kind: 'scroll', delta: 1 });
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, initialView()), { kind: 'scroll', delta: -1 });
  assert.equal(intentFor({ name: 'up', ctrl: false }, { ...initialView(), input: 'draft' }), null);
});

test('/exit aliases /quit and help lists paging and explicit exit keys', () => {
  assert.equal(findCommand('exit'), findCommand('quit'));
  assert.match(KEYS_HELP, /PageUp\/PageDown/);
  assert.match(KEYS_HELP, /Ctrl\+End/);
  assert.match(KEYS_HELP, /Ctrl\+D/);
});

test('closing the slash menu preserves the typed command', () => {
  const view: TuiView = { ...initialView(), input: '/hel', slashIndex: 2 };
  assert.equal(closeSlashMenu(view).input, '/hel');
  assert.equal(closeSlashMenu(view).slashIndex, 0);
});

test('an answered approval that lingers is not a question: the / menu keys reach it', () => {
  // Answered cards stay on screen until their turn ends (project.ts keeps the verdict);
  // the menu hidden under a PENDING card must come back once the verdict is in.
  const pendingApproval = withApproval().approval;
  assert.ok(pendingApproval !== null);
  const answered: TuiView = { ...withApproval(), approval: { ...pendingApproval, verdict: 'once', by: 'user' } };
  const open = withApproval();
  const menuView = { ...initialView(), input: '/' };
  // Pending question: the card owns the keys (the menu is not even rendered).
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, { ...open, input: '/' }), { kind: 'approvalMove', delta: 1 });
  assert.equal(intentFor({ name: 'p', ctrl: true }, open), null);
  // Answered lingering card: the menu owns them again, exactly like no card at all.
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, { ...answered, input: '/' }), { kind: 'slashMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'p', ctrl: true }, answered), { kind: 'palette' });
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, menuView), { kind: 'slashMove', delta: 1 });
});

test('Shift+Tab cycles the mode everywhere; Ctrl+L repaints (ADR-160 ①③)', () => {
  const idle = initialView();
  assert.deepEqual(intentFor({ name: 'tab', ctrl: false, shift: true }, idle), { kind: 'modeCycle' });
  // Over an open panel too: the cycle is whole-app state, the panel keeps its own keys.
  const withPanel = { ...initialView(), taskPanel: { index: 0 } };
  assert.deepEqual(intentFor({ name: 'tab', ctrl: false, shift: true }, withPanel), { kind: 'modeCycle' });
  // Plain Tab is untouched: it completes the `/` menu, and here is not bound at all.
  assert.equal(intentFor({ name: 'tab', ctrl: false }, idle), null);
  assert.deepEqual(intentFor({ name: 'l', ctrl: true }, idle), { kind: 'repaint' });
});

test('idle Esc arms, the second press inside the window recalls; a running turn still cancels (ADR-160 ②)', () => {
  const idle = initialView();
  // First press: silent arm.
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, idle, 1_000, 0, 0), { kind: 'armRecall' });
  // Second press inside 400ms: recall.
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, idle, 1_200, 0, 1_400), { kind: 'recallLast' });
  // Too late: re-arm instead.
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, idle, 2_000, 0, 1_400), { kind: 'armRecall' });
  // A running turn keeps the classic meaning.
  const running = { ...initialView(), turn: { id: 't', state: 'streaming', reason: null, cronSourced: false } };
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, running, 1_000, 0, 1_400), { kind: 'cancel' });
});
