import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { initialView, type TuiView } from '../src/app/view.js';
import { closeView, project, streamText } from '../src/app/project.js';

/**
 * `project()` is a pure function of the log (ADR-059 ②), so every assertion here is about
 * the two properties that make the rest of the frontend testable:
 *
 *   1. the same log produces the same view, twice;
 *   2. what the view shows is derived from facts the log actually carries — never from the
 *      order in which a token happened to arrive.
 *
 * No renderer is involved: this file runs anywhere, which is the point of putting the
 * screen's derivation in a function rather than in a component.
 */

let seq = 0;

function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return {
    seq,
    ts: 1_700_000_000_000 + seq,
    sessionId: 'sess_test',
    turnId: 'turn_1',
    type,
    ...body,
  };
}

function fresh(): TuiView {
  seq = 0;
  return initialView();
}

/** One realistic turn: a question, a tool call, an approval, an answer. */
function oneTurn(): readonly WireEvent[] {
  seq = 0;
  return [
    event('session.opened', { schemaVersion: 1, cowcatVersion: '0.0.0', shell: { kind: 'posix', executable: '/bin/sh' } }),
    event('turn.opened', { input: '把 a.ts 里的 1 改成 2' }),
    event('turn.transitioned', { from: 'opened', to: 'requesting', reason: null }),
    event('turn.transitioned', { from: 'requesting', to: 'streaming', reason: null }),
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Read', input: {} }], reasoning: [], stopReason: null }),
    event('turn.transitioned', { from: 'streaming', to: 'awaiting_tools', reason: null }),
    event('policy.decided', { callId: 'c1', decision: { verdict: 'allow', rule: 'reads-are-free', reason: null } }),
    event('tool.finished', {
      callId: 'c1',
      name: 'Read',
      ok: true,
      output: 'export const value = 1;\n',
      facts: null,
      truncation: null,
      attachments: null,
      path: '/work/a.ts',
    }),
    event('turn.transitioned', { from: 'awaiting_tools', to: 'requesting', reason: null }),
    event('model.message', { text: '改好了。', toolCalls: [], reasoning: [], stopReason: { kind: 'end', raw: 'end_turn' } }),
    event('model.usage', { usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 } }),
    event('turn.transitioned', { from: 'requesting', to: 'finishing', reason: null }),
    event('turn.transitioned', { from: 'finishing', to: 'completed', reason: null }),
  ];
}

function replay(events: readonly WireEvent[]): TuiView {
  return events.reduce<TuiView>((view, item) => project(view, item), initialView());
}

test('the same log produces the same view, twice', () => {
  const events = oneTurn();
  assert.deepEqual(replay(events), replay(events));
});

test('one turn, in the order a user reads it', () => {
  const view = replay(oneTurn());

  assert.equal(view.sessionId, 'sess_test');
  assert.deepEqual(
    view.entries.map((entry) => entry.kind),
    ['user', 'tool', 'assistant'],
  );

  const [user, tool, assistant] = view.entries;
  assert.ok(user?.kind === 'user' && tool?.kind === 'tool' && assistant?.kind === 'assistant');
  assert.equal(user.text, '把 a.ts 里的 1 改成 2');
  assert.equal(tool.name, 'Read');
  assert.equal(tool.ok, true);
  assert.equal(tool.path, '/work/a.ts');
  assert.equal(tool.truncation, null);
  assert.equal(tool.attachments.length, 0);
  assert.equal(assistant.text, '改好了。');
  // The empty `model.message` that carried the tool call contributes no entry, and the
  // one that carried the answer contributes no calls.
  assert.equal(assistant.calls, 0);

  // The turn ended, so nothing is left half-open.
  assert.equal(view.turn?.state, 'completed');
  assert.equal(view.streaming, '');
  assert.equal(view.approval, null);
  assert.deepEqual(view.usage, { input: 100, output: 20 });
  // Every event advanced the sequence, including the ones with nothing to show.
  assert.equal(view.lastSeq, oneTurn().length);
});

test('deltas are display only: they accumulate, and the event that replaces them drops them', () => {
  const view = initialView();
  const withQuestion = project(view, event('turn.opened', { input: 'hi' }));
  const streamed = streamText(streamText(withQuestion, { type: 'model.delta', turnId: 'turn_1', text: '盯' }), {
    type: 'model.delta',
    turnId: 'turn_1',
    text: '着',
  });
  assert.equal(streamed.streaming, '盯着');

  const settled = project(streamed, event('model.message', { text: '盯着', toolCalls: [], reasoning: [], stopReason: null }));
  assert.equal(settled.streaming, '', 'the final event clears what streamed');
  assert.deepEqual(
    settled.entries.map((entry) => entry.kind),
    ['user', 'assistant'],
  );
});

test('an empty answer is worth a line unless tool calls carried the turn', () => {
  const withCalls = project(
    initialView(),
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Read', input: {} }], reasoning: [], stopReason: null }),
  );
  assert.equal(withCalls.entries.length, 0, 'the calls are the answer');

  const withNothing = project(initialView(), event('model.message', { text: '', toolCalls: [], reasoning: [], stopReason: null }));
  assert.deepEqual(
    withNothing.entries.map((entry) => entry.kind),
    ['notice'],
  );
});

test('a tool result reports the truncation and the attachment references it carried', () => {
  const view = project(
    initialView(),
    event('tool.finished', {
      callId: 'c1',
      name: 'Read',
      ok: false,
      output: 'png/jpeg/gif/webp only',
      facts: null,
      truncation: { truncated: true, dropped: null, reason: 'grep: head_limit 1' },
      attachments: [
        { type: 'image', mediaType: 'image/png', path: '/work/shot.png', bytes: 24, width: 4, height: 3, pages: null },
      ],
      path: '/work/shot.png',
    }),
  );

  const entry = view.entries[0];
  assert.ok(entry?.kind === 'tool');
  assert.equal(entry.ok, false);
  assert.equal(entry.truncation, 'grep: head_limit 1');
  // The path, not the bytes: the log holds references (ADR-057).
  assert.deepEqual(entry.attachments, ['/work/shot.png']);
});

test('an approval is opened by its request and closed by the answer to *that* call', () => {
  const asked = project(initialView(), event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }));
  // The whole shape, because "which rule stopped it" is as much a part of the question as
  // the tool's name.
  assert.deepEqual(asked.approval, { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null, verdict: null, by: null });

  // A different call's answer must not close this question.
  const other = project(asked, event('approval.answered', { callId: 'c9', key: 'k', verdict: 'always', by: 'user' }));
  assert.equal(other.approval?.verdict, null);

  const answered = project(other, event('approval.answered', { callId: 'c7', key: 'k', verdict: 'reject', by: 'user' }));
  assert.deepEqual(answered.approval, { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null, verdict: 'reject', by: 'user' });

  // And the end of the turn takes the question away entirely.
  const after = project(answered, event('turn.transitioned', { from: 'awaiting_approval', to: 'cancelled', reason: 'aborted' }));
  assert.equal(after.approval, null);
  assert.equal(after.turn?.reason, 'aborted');
});

test('the todo list is replaced wholesale, and its status is not ours to interpret', () => {
  const first = project(
    initialView(),
    event('todo.updated', { todos: [{ content: 'a', status: 'in_progress', activeForm: 'doing a' }] }),
  );
  assert.equal(first.todos.length, 1);

  const second = project(
    first,
    event('todo.updated', { todos: [{ content: 'b', status: 'completed', activeForm: 'doing b' }] }),
  );
  assert.deepEqual(
    second.todos.map((todo) => todo.content),
    ['b'],
  );
});

test('an unknown event type earns exactly one line', () => {
  // `fresh()` also resets the sequence counter the event builder uses, so the numbers in
  // this test are the ones the assertions talk about.
  const first = project(fresh(), event('sandbox.mood', { nostalgic: true }));
  assert.deepEqual(
    first.entries.map((entry) => entry.kind),
    ['notice'],
  );
  assert.deepEqual(first.unsupported, ['sandbox.mood']);

  const second = project(first, event('sandbox.mood', { nostalgic: false }));
  assert.equal(second.entries.length, 1, 'the second sighting adds nothing');
  assert.equal(second.lastSeq, 2, 'but it is still a fact the log has');
});

test('the language is decided by the first user message, once', () => {
  const english = project(initialView(), event('turn.opened', { input: 'fix the bug' }));
  assert.equal(english.lang, 'en');

  const chinese = project(initialView(), event('turn.opened', { input: '修一下这个 bug' }));
  assert.equal(chinese.lang, 'zh');

  // An empty first turn decides nothing, and a later one still can.
  const empty = project(initialView(), event('turn.opened', { input: '   ' }));
  assert.equal(empty.langDecided, false);
  assert.equal(project(empty, event('turn.opened', { input: 'hello there' })).lang, 'en');
});

test('a closed transport is a fact about the view, not a wipe', () => {
  const view = replay(oneTurn());
  const closed = closeView(view);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.entries, view.entries);
});
