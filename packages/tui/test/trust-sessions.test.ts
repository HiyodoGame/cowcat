import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionSummary, TrustWithheld } from '@corescense/cowcat-protocol';
import { closeSessionPanel, closeTrust, initialView, moveSessionPanel, moveTrust, openSessionPanel, openTrust, pickableSessions, withSessionList } from '../src/app/view.js';
import { intentFor } from '../src/app/keymap.js';
import { frameOf } from '../src/components/session-frame.js';
import { sessionPanel } from '../src/components/session-panel.js';
import { trustCard } from '../src/components/trust-card.js';
import { nodesOf, textOf } from './scene.js';

const WITHHELD: TrustWithheld = { rules: 2, instructions: 1, skills: 3, mcpServers: 1, hooks: 0 };

test('pickableSessions keeps this workspace’s top-level sessions, all keeps everything', () => {
  const summary = (id: string, cwd?: string, parent?: string): SessionSummary => ({ sessionId: id, lastSeq: 3, ...(cwd === undefined ? {} : { cwd }), ...(parent === undefined ? {} : { parentSessionId: parent }) });
  const sessions = [summary('here', 'F:\\work'), summary('child', 'F:\\work', 'here'), summary('elsewhere', 'F:\\other'), summary('old-no-cwd')];
  assert.deepEqual(pickableSessions(sessions, 'F:\\work', false).map((session) => session.sessionId), ['here']);
  assert.equal(pickableSessions(sessions, 'F:\\work', true).length, 4);
});

test('the session picker window follows the selection and marks the current session', () => {
  const many: SessionSummary[] = Array.from({ length: 24 }, (_, i) => ({ sessionId: `sess_${String(i)}`, lastSeq: i }));
  const panel = sessionPanel(many, 23, 'sess_23', 60);
  const text = textOf([panel]);
  assert.match(text, /sess_23/);
  assert.doesNotMatch(text, /sess_0/);
  assert.equal(panel.kind === 'panel' && panel.children.every((node) => node.kind !== 'choice' || !node.text.startsWith('▸')), true);
  assert.match(textOf([sessionPanel([{ sessionId: 's', lastSeq: 1 }], 0, 's', 60)]), /（当前）/);
  const empty = sessionPanel([], 0, null, 60);
  assert.equal(empty.kind === 'panel' && empty.title.includes('还没有会话'), true);
});

test('trust choices expose selection as data rather than glyphs', () => {
  const card = trustCard(WITHHELD, 0, 'F:\\newdir', 70);
  assert.match(textOf([card]), /2 条 allow 规则/);
  const granted = nodesOf([card]).find((node) => node.kind === 'choice' && node.text === '信任此工作区');
  assert.equal(granted?.kind === 'choice' && granted.selected, true);
  const skipped = nodesOf([trustCard(WITHHELD, 1, 'F:\\newdir', 70)]).find((node) => node.kind === 'choice' && node.text.startsWith('跳过'));
  assert.equal(skipped?.kind === 'choice' && skipped.selected, true);
});

test('trust and session keys retain their existing owners', () => {
  let view = moveTrust(openTrust(initialView(), WITHHELD, 'F:\\d'), 1);
  view = moveTrust(view, 1);
  assert.equal(view.trustCursor, 0);
  assert.deepEqual(intentFor({ name: 'up', ctrl: false }, view), { kind: 'trustMove', delta: -1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, view), { kind: 'trustSkip' });
  assert.equal(intentFor({ name: 'p', ctrl: true }, view), null);
  assert.notEqual(intentFor({ name: 'p', ctrl: true }, closeTrust(view)), null);
  let picker = openSessionPanel(withSessionList(initialView(), [{ sessionId: 'a', lastSeq: 1 }, { sessionId: 'b', lastSeq: 2 }]), false);
  picker = moveSessionPanel(picker, 1, 2);
  picker = moveSessionPanel(picker, 1, 2);
  assert.equal(picker.sessionPanel?.index, 0);
  assert.deepEqual(intentFor({ name: 'down', ctrl: false }, picker), { kind: 'sessionMove', delta: 1 });
  assert.deepEqual(intentFor({ name: 'escape', ctrl: false }, picker), { kind: 'sessionsClose' });
  assert.equal(closeSessionPanel(picker).sessionPanel, null);
});

test('the frame mounts a native trust panel before any session exists', () => {
  const dock = frameOf(openTrust(initialView(), WITHHELD, 'F:\\newdir'), { width: 80, height: 24, now: 0 }).dock ?? [];
  assert.equal(dock[0]?.kind, 'panel');
  assert.match(textOf(dock), /信任此工作区/);
});
