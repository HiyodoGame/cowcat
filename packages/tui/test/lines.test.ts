import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { detectLang } from '../src/app/copy.js';
import { initialView } from '../src/app/view.js';
import { project, streamText } from '../src/app/project.js';
import { transcriptLines, TOOL_OUTPUT_TAIL } from '../src/components/transcript.js';
import { statusLine } from '../src/components/status-bar.js';

/**
 * The screen's words, asserted before any renderer is involved.
 *
 * Everything here is a pure function of the view model, so it runs anywhere — including a
 * machine with no renderer installed, which is not true of the frame snapshot next door.
 * When a frame looks wrong, this is the file that says whether the LINES were wrong or the
 * drawing was.
 */

let seq = 0;

function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1, sessionId: 'sess_test', turnId: 'turn_1', type, ...body };
}

test('the transcript marks who is speaking, and leaves the agent unmarked', () => {
  seq = 0;
  const view = [
    event('turn.opened', { input: '把 1 改成 2' }),
    event('tool.finished', {
      callId: 'c1',
      name: 'Edit',
      ok: true,
      output: 'updated src/a.ts',
      facts: null,
      truncation: null,
      attachments: null,
      path: '/work/a.ts',
    }),
    event('model.message', { text: '改好了。', toolCalls: [], reasoning: [], stopReason: null }),
  ].reduce((current, item) => project(current, item), initialView());

  const lines = transcriptLines(view);
  assert.deepEqual(
    lines.map((row) => [row.text.trimStart().split(' ')[0], row.token]),
    [
      ['❯', 'user'],
      ['⏺', 'tool'],
      ['updated', 'tool'],
      ['改好了。', 'assistant'],
    ],
  );
  // The path rides the tool's header line: it is the one fact a wrong-tool-call is read
  // against.
  assert.match(lines[1]?.text ?? '', /Edit ok — \/work\/a\.ts/);
});

test('a tool result shows its status, its attachments and the tail of its output', () => {
  seq = 0;
  const view = project(
    initialView(),
    event('tool.finished', {
      callId: 'c1',
      name: 'Bash',
      ok: false,
      output: 'a\nb\nc\nd\ne\n',
      facts: null,
      truncation: { truncated: true, dropped: 40, reason: 'bash: output cap (100000 characters per stream)' },
      attachments: [{ type: 'image', mediaType: 'image/png', path: '/work/x.png', bytes: 1, width: 1, height: 1, pages: null }],
      path: null,
    }),
  );

  const texts = transcriptLines(view).map((row) => row.text);
  assert.equal(texts[0], '⏺ Bash 失败');
  assert.match(texts[1] ?? '', /附件 ×1：\/work\/x\.png/);
  assert.match(texts[2] ?? '', /bash: output cap/);
  // The brand guide's rule for a terminal-output card: the last three lines, and a line
  // saying how many were folded away rather than pretending they never existed.
  assert.match(texts[3] ?? '', /上面还有 2 行/);
  assert.deepEqual(texts.slice(-TOOL_OUTPUT_TAIL), ['    c', '    d', '    e']);
});

test('streamed text is drawn as the agent speaking, and nothing else changes', () => {
  seq = 0;
  const base = project(initialView(), event('turn.opened', { input: 'hi' }));
  const streamed = streamText(base, { type: 'model.delta', turnId: 'turn_1', text: '盯' });
  const lines = transcriptLines(streamed);
  assert.deepEqual(
    lines.map((row) => [row.text, row.token]),
    [
      ['❯ hi', 'user'],
      ['盯', 'assistant'],
    ],
  );
});

test('the status bar says what is happening, in the brand guide\'s words', () => {
  seq = 0;
  const empty = initialView();
  assert.match(statusLine(empty).text, /还没有会话.*在。说正事吧。/);

  // A Chinese prompt, because the copy follows the user's language (see below).
  const asked = project(
    project(initialView(), event('session.opened', { schemaVersion: 1, cowcatVersion: 'x', shell: { kind: 'posix', executable: '/bin/sh' } })),
    event('turn.opened', { input: '你好' }),
  );
  const working = statusLine(project(asked, event('turn.transitioned', { from: 'requesting', to: 'streaming', reason: null })));
  assert.match(working.text, /盯着编译器出神中/);
  assert.equal(working.token, 'act');

  const pending = statusLine(
    project(asked, event('approval.requested', { callId: 'c1', name: 'Bash', rule: 'exec-asks', reason: null })),
  );
  // The tool and the rule win the row: they are what the user is deciding about, and a
  // status bar is one line.
  assert.equal(pending.text, 'sess_test · Bash（exec-asks）——允许？[y/n]');
  assert.equal(pending.token, 'plan');

  const failed = statusLine(
    project(asked, event('turn.transitioned', { from: 'streaming', to: 'failed', reason: 'upstream 503' })),
  );
  assert.match(failed.text, /刚才那步失败了。（upstream 503）/);
  assert.equal(failed.token, 'alert');
});

test('the status bar carries the counts it has and nothing it does not', () => {
  seq = 0;
  const view = [
    event('session.opened', { schemaVersion: 1, cowcatVersion: 'x', shell: { kind: 'posix', executable: '/bin/sh' } }),
    event('todo.updated', {
      todos: [
        { content: 'a', status: 'completed', activeForm: 'doing a' },
        { content: 'b', status: 'pending', activeForm: 'doing b' },
      ],
    }),
    event('model.usage', { usage: { input: 10, output: 3, cacheRead: 0, cacheCreation: 0 } }),
  ].reduce((current, item) => project(current, item), initialView());

  assert.match(statusLine(view).text, /sess_test · 在。说正事吧。 · 待办 1\/2 · ↑10 ↓3/);
  // No model, and that is stated rather than guessed: the log does not carry one.
  assert.doesNotMatch(statusLine(view).text, /model|模型/);
});

test('the copy language follows the user, not the locale', () => {
  assert.equal(detectLang('修一下这个 bug'), 'zh');
  assert.equal(detectLang('fix this bug'), 'en');
  assert.equal(detectLang(''), 'en');
});
