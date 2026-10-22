import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireDelta, WireEvent } from '@corescense/cowcat-protocol';
import { advanceReasoning, initialView, markReplayedTasks, moveTaskPanel, openTaskPanel, revealedReasoning, selectedTask, withScroll, type TuiView } from '../src/app/view.js';
import { closeView, project, streamReasoning, streamText, streamToolOutput } from '../src/app/project.js';
import { findCommand } from '../src/app/commands.js';

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
  assert.deepEqual(view.usage, { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 });
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
  // Held in a variable so the expected `askedAt` is the event's own timestamp rather than a
  // number copied out of a failure message.
  const request = event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null });
  const asked = project(initialView(), request);
  // The whole shape, because "which rule stopped it" is as much a part of the question as the
  // tool's name — and the timestamp is what lets a card say "you still there".
  assert.deepEqual(asked.approval, {
    callId: 'c7',
    name: 'Bash',
    rule: 'exec-asks',
    reason: null,
    warning: null,
    askedAt: request.ts,
    verdict: null,
    by: null,
  });

  // A different call's answer must not close this question.
  const other = project(asked, event('approval.answered', { callId: 'c9', key: 'k', verdict: 'always', by: 'user' }));
  assert.equal(other.approval?.verdict, null);

  const answered = project(other, event('approval.answered', { callId: 'c7', key: 'k', verdict: 'reject', by: 'user' }));
  assert.deepEqual(answered.approval, {
    callId: 'c7',
    name: 'Bash',
    rule: 'exec-asks',
    reason: null,
    warning: null,
    askedAt: request.ts,
    verdict: 'reject',
    by: 'user',
  });

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

test('a compaction earns one line with the count, and the lock edges stay out of the transcript', () => {
  const beforeStart = project(fresh(), event('context.compaction.started', { trigger: 'auto', model: 'test' }));
  assert.deepEqual(beforeStart.entries, [], 'starting is plumbing');

  const compacted = project(
    beforeStart,
    event('context.compacted', { dropped: 12, trigger: 'auto', summary: '## Objective\nx', throughSeq: 9 }),
  );
  assert.equal(compacted.entries.length, 1);
  const line = compacted.entries[0];
  assert.ok(line !== undefined);
  assert.match(line.kind === 'notice' ? line.text : '', /12/);
  assert.equal(line.kind, 'notice');
  assert.deepEqual(compacted.unsupported, [], 'a known event is not an unknown one');

  const finished = project(compacted, event('context.compaction.finished', { ok: true, error: null }));
  assert.equal(finished.entries.length, 1, 'finishing adds nothing');
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

test('turn.opened carries the context window into the view, and an older log leaves it null', () => {
  const opened = project(initialView(), event('turn.opened', { input: 'hi', contextWindow: 200_000 }));
  assert.equal(opened.contextWindow, 200_000);

  // No window in the log — an older kernel, or a preset that declares none. The status bar
  // has no denominator and must not invent one (ADR-105).
  const older = project(initialView(), event('turn.opened', { input: 'hi' }));
  assert.equal(older.contextWindow, null);
});

test('a compaction drops the old measurement instead of showing it against the new history', () => {
  const view: TuiView = {
    ...initialView(),
    contextWindow: 200_000,
    usage: { input: 180_000, output: 500, cacheRead: 0, cacheCreation: 0 },
  };
  const compacted = project(
    view,
    event('context.compacted', {
      trigger: 'auto',
      summary: 'earlier work',
      throughSeq: 3,
      shadowed: [1, 2],
      dropped: 2,
      model: 'test-model',
      usage: null,
    }),
  );
  // 180k was about the history that just got replaced; the bar says nothing until the next
  // `model.usage` measures the new prompt (ADR-105 ②).
  assert.equal(compacted.usage, null);
});

test('a running tool keeps a capped live tail, and loses it when the call finishes (ADR-109)', () => {
  seq = 0;
  const asked = project(
    initialView(),
    event('model.message', {
      text: '',
      toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'build' } }],
      reasoning: [],
      stopReason: null,
    }),
  );
  const fragment = (callId: string, text: string): WireDelta => ({
    type: 'tool.output.delta',
    turnId: 't1',
    callId,
    stream: 'stdout',
    text,
  });

  const withTail = streamToolOutput(asked, fragment('c1', 'first\nsecond\n'));
  assert.deepEqual(withTail.toolOutput['c1'], { text: 'first\nsecond\n', truncated: false });

  // A delta for a call this view is not running is late (the result already landed) and
  // must not resurrect a card.
  assert.equal(streamToolOutput(asked, fragment('c9', 'late')).toolOutput['c9'], undefined);

  // Only the last few KB are kept for display; the durable output has its own cap.
  const long = streamToolOutput(asked, fragment('c1', 'a'.repeat(5_000)));
  const longTail = long.toolOutput['c1'];
  assert.ok(longTail !== undefined);
  assert.equal(longTail.text.length, 4_000);
  assert.equal(longTail.truncated, true, 'the card must be able to say output was dropped');

  // The cap counts grapheme clusters, not UTF-16 units: a split surrogate would paint U+FFFD.
  const emoji = streamToolOutput(asked, fragment('c1', '😀'.repeat(5_000)));
  const emojiTail = emoji.toolOutput['c1'];
  assert.ok(emojiTail !== undefined);
  assert.equal(Array.from(emojiTail.text).length, 4_000);
  assert.equal(emojiTail.text.startsWith('😀'), true);

  const finished = project(
    long,
    event('tool.finished', {
      callId: 'c1',
      name: 'Bash',
      ok: true,
      output: 'done',
      facts: null,
      truncation: null,
      attachments: null,
      path: null,
    }),
  );
  assert.equal(finished.toolOutput['c1'], undefined, 'the durable output replaces the live tail');

  const ended = project(withTail, event('turn.transitioned', { from: 'awaiting_tools', to: 'completed', reason: null }));
  assert.deepEqual(ended.toolOutput, {}, 'a finished turn cannot leave live tails behind');
  const failed = project(withTail, event('turn.transitioned', { from: 'awaiting_tools', to: 'failed', reason: 'boom' }));
  assert.deepEqual(failed.toolOutput, {}, 'a failed turn cannot leave live tails behind either');

  // A new turn starts empty, whatever the previous one left.
  assert.deepEqual(project(long, event('turn.opened', { input: 'again' })).toolOutput, {});
});

test('two running tools keep separate tails, and one finishing does not clear the other', () => {
  seq = 0;
  const asked = project(
    initialView(),
    event('model.message', {
      text: '',
      toolCalls: [
        { callId: 'c1', name: 'Bash', input: { command: 'build' } },
        { callId: 'c2', name: 'Bash', input: { command: 'test' } },
      ],
      reasoning: [],
      stopReason: null,
    }),
  );
  const fragment = (callId: string, text: string): WireDelta => ({
    type: 'tool.output.delta',
    turnId: 't1',
    callId,
    stream: 'stdout',
    text,
  });

  const both = streamToolOutput(streamToolOutput(asked, fragment('c1', 'one')), fragment('c2', 'two'));
  assert.equal(both.toolOutput['c1']?.text, 'one');
  assert.equal(both.toolOutput['c2']?.text, 'two');

  const afterFirst = project(
    both,
    event('tool.finished', {
      callId: 'c1',
      name: 'Bash',
      ok: true,
      output: 'one',
      facts: null,
      truncation: null,
      attachments: null,
      path: null,
    }),
  );
  assert.equal(afterFirst.toolOutput['c1'], undefined);
  assert.equal(afterFirst.toolOutput['c2']?.text, 'two', 'the other call is still running');
});

test('background tasks are projected from their events, and a replayed start is unknown (ADR-113)', () => {
  seq = 0;
  const live = project(
    initialView(),
    event('tool.background.started', { callId: 'c1', taskId: 'bg_a_1', command: 'pnpm dev' }),
  );
  assert.equal(live.tasks.length, 1);
  const started = live.tasks[0];
  assert.ok(started !== undefined);
  assert.equal(started.state, 'running');
  assert.equal(started.command, 'pnpm dev');

  // A start that arrived as replay (seq at or below the snapshot) is not "running": the host
  // that knew about it may be gone.
  const replayed = project(
    { ...initialView(), replayedThrough: 99 },
    event('tool.background.started', { callId: 'c1', taskId: 'bg_a_1', command: 'pnpm dev' }),
  );
  assert.equal(replayed.tasks[0]?.state, 'unknown');

  const finished = project(
    live,
    event('tool.background.finished', {
      callId: 'c1',
      taskId: 'bg_a_1',
      exitCode: 0,
      signal: null,
      state: 'exited',
      reason: 'none',
      facts: null,
      tail: '',
      truncated: false,
      dropped: 0,
    }),
  );
  const done = finished.tasks[0];
  assert.ok(done !== undefined);
  assert.equal(done.state, 'exited');
  assert.equal(done.exitCode, 0);
  assert.notEqual(done.endedAt, null);

  // Tasks outlive turns: the end of a turn says nothing about them.
  const ended = project(finished, event('turn.transitioned', { from: 'streaming', to: 'completed', reason: null }));
  assert.equal(ended.tasks.length, 1);

  // With the transport gone, "running" can no longer be known.
  const closed = closeView(
    project(initialView(), event('tool.background.started', { callId: 'c1', taskId: 'bg_b_1', command: 'npm test' })),
  );
  assert.equal(closed.tasks[0]?.state, 'unknown');
});

test('markReplayedTasks only downgrades starts at or below the snapshot seq (ADR-113)', () => {
  const task = (taskId: string, startedSeq: number): TuiView['tasks'][number] => ({
    taskId,
    callId: `call_${taskId}`,
    command: 'pnpm dev',
    startedAt: 0,
    startedSeq,
    state: 'running',
    endedAt: null,
    exitCode: null,
  });
  const view: TuiView = { ...initialView(), tasks: [task('bg_a_1', 2), task('bg_a_2', 10)] };

  const marked = markReplayedTasks(view, 5);
  assert.equal(marked.replayedThrough, 5);
  const [replayed, live] = marked.tasks;
  assert.ok(replayed !== undefined && live !== undefined);
  assert.equal(replayed.state, 'unknown', 'a start inside the replay has no known end');
  assert.equal(live.state, 'running', 'a start after the snapshot was watched live');
});

test('the task panel opens, wraps, and reports the selected task', () => {
  assert.equal(openTaskPanel(initialView()).taskPanel, null, 'nothing to show, nothing opens');

  const task = (taskId: string): TuiView['tasks'][number] => ({
    taskId,
    callId: 'c1',
    command: 'pnpm dev',
    startedAt: 0,
    startedSeq: 2,
    state: 'running',
    endedAt: null,
    exitCode: null,
  });
  const view: TuiView = { ...initialView(), tasks: [task('bg_a_1'), task('bg_a_2')] };
  const open = openTaskPanel(view);
  assert.deepEqual(open.taskPanel, { index: 0 });
  assert.equal(selectedTask(open)?.taskId, 'bg_a_1');

  const wrapped = moveTaskPanel(open, -1);
  assert.deepEqual(wrapped.taskPanel, { index: 1 }, 'the list wraps like the other panels');
  assert.equal(selectedTask(wrapped)?.taskId, 'bg_a_2');
});

test('a closed transport is a fact about the view, not a wipe', () => {
  const view = replay(oneTurn());
  const closed = closeView(view);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.entries, view.entries);
});

test('a finished delegation is one line that names the child; the start is not a line at all', () => {
  const view = [
    event('subagent.started', { callId: 'c1', childSessionId: 'sess_child', role: 'explore', description: 'list files' }),
    event('subagent.finished', {
      callId: 'c1',
      childSessionId: 'sess_child',
      role: 'explore',
      ok: true,
      state: 'completed',
      turns: 2,
      partial: false,
      usage: null,
      reason: null,
    }),
  ].reduce(project, fresh());

  // One line, not two: a row that appears and only resolves later reads worse than one that
  // arrives with its result (ADR-079 ①). The started fact stays in the log either way.
  assert.equal(view.entries.length, 1);
  const entry = view.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, 'notice');
  assert.match(entry.text, /sess_child/);
  assert.match(entry.text, /explore/);
  assert.match(entry.text, /2/);
  assert.equal(view.unsupported.includes('subagent.started'), false);
});


test('turn.noted is a notice, not assistant text, and a replay says the same thing', () => {
  const log: readonly WireEvent[] = [
    event('turn.opened', { input: '看看这个仓库' }),
    event('turn.noted', { note: 'instructions-skipped', message: '工作区指令未注入：folder not trusted' }),
  ];

  const once = log.reduce(project, fresh());
  const twice = log.reduce(project, fresh());

  const entry = once.entries.at(-1);
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, 'notice');
  assert.equal(entry.level, 'warn');
  assert.match(entry.text, /工作区指令未注入/u);
  // The model did not say this, so it must not enter the answered half of the transcript.
  assert.equal(once.entries.filter((item) => item.kind === 'assistant').length, 0);
  assert.deepEqual(twice.entries, once.entries);
  assert.equal(once.unsupported.includes('turn.noted'), false);
});

test('output arriving while scrolled up is counted, and returning to the tail clears it', () => {
  const scrolled = withScroll(initialView(), 5);
  const view = project(
    scrolled,
    event('model.message', { text: '新内容', toolCalls: [], reasoning: [], stopReason: null }),
  );
  assert.equal(view.scrollOffset, 5, 'following does not resume on its own');
  assert.equal(view.newSinceScroll, 1);

  const back = withScroll(view, -5);
  assert.equal(back.scrollOffset, 0);
  assert.equal(back.newSinceScroll, 0);
});

test('reasoning is live while it streams, then collapses into the answer', () => {
  const live = streamReasoning(streamReasoning(initialView(), {
    type: 'reasoning.delta',
    turnId: 'turn_1',
    text: '先看',
  }), { type: 'reasoning.delta', turnId: 'turn_1', text: '调用点' });
  assert.equal(live.reasoningStream, '先看调用点');

  // Received in one chunk, revealed a few characters at a time (ADR-099).
  assert.equal(revealedReasoning(live), '');
  assert.equal(revealedReasoning(advanceReasoning(live, 2)), '先看');

  const done = project(
    { ...live, thinkingExpanded: true },
    event('model.message', {
      text: '改好了。',
      toolCalls: [],
      reasoning: [{ type: 'thinking', text: '先看调用点', signature: 's' }],
      stopReason: null,
    }),
  );

  assert.equal(done.reasoningStream, '');
  assert.equal(done.thinkingExpanded, false, 'a finished turn starts collapsed');
  const entry = done.entries.at(-1);
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, 'assistant');
  assert.deepEqual(entry.reasoning, ['先看调用点']);
});

test('reasoning rides along with the answer, and redacted blocks are counted', () => {
  const log: readonly WireEvent[] = [
    event('turn.opened', { input: '改一下这个函数' }),
    event('model.message', {
      text: '改好了。',
      toolCalls: [],
      reasoning: [
        { type: 'thinking', text: '先看调用点，再改实现。', signature: 'sig' },
        { type: 'redacted', data: 'opaque' },
      ],
      stopReason: null,
    }),
  ];

  const view = log.reduce(project, fresh());
  const entry = view.entries.at(-1);
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, 'assistant');
  assert.deepEqual(entry.reasoning, ['先看调用点，再改实现。']);
  assert.equal(entry.redactedThinking, 1);

  // Same log, same view: the thinking is part of the projection, not a side channel.
  assert.deepEqual(log.reduce(project, fresh()).entries, view.entries);
});


test('skills.loaded fills the /skills list without touching the transcript', () => {
  const view = project(
    fresh(),
    event('skills.loaded', {
      trigger: 'start',
      text: '<system-reminder>catalog</system-reminder>',
      skills: [
        { name: 'pdf', layer: 'project', origin: 'cowcat', bytes: 12 },
        { name: 'mine', layer: 'user', origin: 'claude', bytes: 8 },
      ],
    }),
  );
  assert.deepEqual(view.skills, [
    { name: 'pdf', layer: 'project', origin: 'cowcat' },
    { name: 'mine', layer: 'user', origin: 'claude' },
  ]);
  assert.equal(view.entries.length, 0, 'the catalog is context, not conversation');
});

test('/skills names the skills, and says so when there are none', () => {
  const command = findCommand('skills');
  assert.ok(command !== undefined);
  const empty = command.run(fresh());
  assert.equal(empty.kind, 'notice');
  assert.match(empty.text, /没有可用技能/);

  const view = project(
    fresh(),
    event('skills.loaded', {
      trigger: 'start',
      text: 'catalog',
      skills: [{ name: 'pdf', layer: 'project', origin: 'cowcat', bytes: 12 }],
    }),
  );
  const listed = command.run(view);
  assert.equal(listed.kind, 'notice');
  assert.match(listed.text, /pdf（project\/cowcat）/);
});
