import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionSummary, TrustWithheld } from '@corescense/cowcat-protocol';
import {
  closeSessionPanel,
  closeTrust,
  initialView,
  moveSessionPanel,
  moveTrust,
  openSessionPanel,
  openTrust,
  pickableSessions,
  withSessionList,
} from '../src/app/view.js';
import { intentFor } from '../src/app/keymap.js';
import { frameOf } from '../src/components/session-frame.js';
import { sessionPanelLines } from '../src/components/session-panel.js';
import { trustCardLines } from '../src/components/trust-card.js';

const WITHHELD: TrustWithheld = { rules: 2, instructions: 1, skills: 3, mcpServers: 1, hooks: 0 };

test('pickableSessions keeps this workspace’s top-level sessions, all keeps everything (ADR-158 ①)', () => {
  const summary = (id: string, cwd?: string, parent?: string): SessionSummary => ({
    sessionId: id,
    lastSeq: 3,
    ...(cwd === undefined ? {} : { cwd }),
    ...(parent === undefined ? {} : { parentSessionId: parent }),
  });
  const sessions = [
    summary('here', 'F:\\work'),
    summary('child', 'F:\\work', 'here'),
    summary('elsewhere', 'F:\\other'),
    summary('old-no-cwd'),
  ];
  // Scoped: this workspace's top-level sessions only — children fold, other workspaces
  // and pre-cwd summaries stay out.
  assert.deepEqual(
    pickableSessions(sessions, 'F:\\work', false).map((session) => session.sessionId),
    ['here'],
  );
  assert.equal(pickableSessions(sessions, 'F:\\work', true).length, 4);
});

test('the session picker window follows the selection and marks the current session', () => {
  const many: SessionSummary[] = Array.from({ length: 24 }, (_, i) => ({
    sessionId: `sess_${String(i)}`,
    lastSeq: i,
  }));
  const lines = sessionPanelLines(many, 23, 'sess_23', 60);
  const text = lines.map((row) => row.text).join('\n');
  assert.match(text, /▸ sess_23/);
  assert.doesNotMatch(text, /sess_0/, 'the window is on the tail');
  // `（当前）` is what tells the reader which row a switch would leave.
  const current = sessionPanelLines([{ sessionId: 's', lastSeq: 1 }], 0, 's', 60).map((r) => r.text).join('\n');
  assert.match(current, /（当前）/);
  assert.match(sessionPanelLines([], 0, null, 60)[0]?.text ?? '', /还没有会话/);
});

test('the trust card lists what trust unlocks and offers the two answers (ADR-157 ①)', () => {
  const lines = trustCardLines(WITHHELD, 0, 'F:\\newdir', 70).map((row) => row.text).join('\n');
  assert.match(lines, /F:\\newdir/);
  assert.match(lines, /2 条 allow 规则/);
  assert.match(lines, /❯ 信任此工作区/);
  const skipped = trustCardLines(WITHHELD, 1, 'F:\\newdir', 70).map((row) => row.text).join('\n');
  assert.match(skipped, /❯ 跳过/);
  assert.doesNotMatch(skipped, /❯ 信任此工作区/);
});

test('the trust card owns arrows and Esc; Enter answers through submit, not a key', () => {
  let view = openTrust(initialView(), WITHHELD, 'F:\\d');
  view = moveTrust(view, 1);
  assert.equal(view.trustCursor, 1);
  view = moveTrust(view, 1);
  assert.equal(view.trustCursor, 0, 'a two-row list wraps');
  assert.deepEqual(intentFor({ name: 'up', ctrl: false }, view), { kind: 'trustMove', delta: -1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'trustSkip' });
  // Ctrl-P stays chrome while the question is on screen (the approval-card rule).
  assert.equal(intentFor({ name: 'p', ctrl: true }, view), null);
  const closed = closeTrust(view);
  assert.equal(closed.trust, null);
  assert.notEqual(intentFor({ name: 'p', ctrl: true }, closed), null);
});

test('the session picker owns arrows and Esc while open (ADR-158 ②)', () => {
  let view = openSessionPanel(
    withSessionList(initialView(), [
      { sessionId: 'a', lastSeq: 1 },
      { sessionId: 'b', lastSeq: 2 },
    ]),
    false,
  );
  view = moveSessionPanel(view, 1, view.sessionList.length);
  assert.equal(view.sessionPanel?.index, 1);
  view = moveSessionPanel(view, 1, view.sessionList.length);
  assert.equal(view.sessionPanel?.index, 0, 'the picker wraps');
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, view), { kind: 'sessionMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'sessionsClose' });
  assert.equal(closeSessionPanel(view).sessionPanel, null);
});

test('the frame mounts the trust card in the dock before any session exists', () => {
  const view = openTrust(initialView(), WITHHELD, 'F:\\newdir');
  const dock = frameOf(view, { width: 80, height: 24, now: 0 }).dock ?? [];
  const text = dock.map((row) => row.text).join('\n');
  assert.match(text, /工作区信任/);
  assert.match(text, /❯ 信任此工作区/);
});
