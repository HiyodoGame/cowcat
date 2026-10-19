import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { initialView, toggleExpanded, type TuiView } from '../src/app/view.js';
import { project } from '../src/app/project.js';
import { frameOf } from '../src/components/session-frame.js';
import { statusLine } from '../src/components/status-bar.js';
import { paletteLines } from '../src/components/palette.js';
import { COMMANDS } from '../src/app/commands.js';
import { stringWidth } from '../src/text/width.js';
import { line } from '../src/ui/line.js';
import type { Line } from '../src/ui/line.js';

/**
 * Every card, asserted as text — before any renderer is involved.
 *
 * The frame snapshots next door own the exact bytes of the whole screen; this file owns the
 * properties each card must have on its own, and the one that matters most is the box
 * invariant: **a card's every line is exactly `width` cells wide.** A card one cell too wide
 * wraps, and a wrapped card is a card whose border is in the middle of a sentence.
 *
 * All of it runs without a terminal, which is the point of `components/` producing `Line[]`
 * rather than renderables (ADR-066 ③).
 */
const WIDTH = 48;

let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1_000, sessionId: 'sess_cards', turnId: 'turn_1', type, ...body };
}

function viewOf(events: readonly WireEvent[]): TuiView {
  return events.reduce((view, item) => project(view, item), initialView());
}

function bodyLines(view: TuiView): readonly Line[] {
  return frameOf(view, { width: WIDTH, now: 1_000 }).body;
}

/** The box invariant, for every scene in this file. Blank rows are the frame's separators. */
function assertCardWidths(lines: readonly Line[], label: string): void {
  for (const [index, row] of lines.entries()) {
    if (row.text === '') continue;
    assert.equal(
      stringWidth(row.text),
      WIDTH,
      `${label}: line ${String(index + 1)} is ${String(stringWidth(row.text))} cells, not ${String(WIDTH)}: ${JSON.stringify(row.text)}`,
    );
  }
}

test('the user speaks from inside a card', () => {
  seq = 0;
  const view = viewOf([event('turn.opened', { input: '把 value 改成 total' })]);
  const lines = bodyLines(view);
  assert.match(lines[0]?.text ?? '', /^╭─ 你/);
  assert.match(lines.map((row) => row.text).join('\n'), /把 value 改成 total/);
  // One closing border, and the frame puts a blank line after the entry.
  assert.equal(lines.filter((row) => row.text.startsWith('╰')).length, 1);
  assert.equal(lines.at(-1)?.text, '');
  assertCardWidths(lines, 'user');
  assert.equal(lines[1]?.token, 'user');
});

test('a long line wraps inside the card instead of breaking its border', () => {
  seq = 0;
  const view = viewOf([event('turn.opened', { input: '把 value 改成 total 并且顺手把那三个 helper 也重命名一下，顺便补上注释' })]);
  const lines = bodyLines(view);
  assert.ok(lines.length > 4, 'the text needs more than one row');
  assertCardWidths(lines, 'wrapped user card');
  // The closing border is the last row, and there is exactly one of them.
  assert.equal(lines.filter((row) => row.text.startsWith('╰')).length, 1);
});

test('the agent answers without a box, and says when the answer came with calls', () => {
  seq = 0;
  const view = viewOf([
    event('model.message', { text: '改好了。', toolCalls: [{ callId: 'c1', name: 'Read', input: { file_path: '/a.ts' } }], reasoning: [], stopReason: null }),
  ]);
  const lines = bodyLines(view);
  // One assertion for the whole line: `text`, `token` and `bold` in one go, and no chained
  // optional access (which `assert.equal`'s narrowing turns into a lint error).
  assert.deepEqual(lines[0], line('改好了。', 'assistant'));
  assert.match(lines[1]?.text ?? '', /带了 1 个工具调用/);
});

test('a tool result is a card: status, path, tail, and a way to see the rest', () => {
  seq = 0;
  const base = viewOf([
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'npm test' } }], reasoning: [], stopReason: null }),
    event('tool.finished', {
      callId: 'c1',
      name: 'Bash',
      ok: false,
      output: 'one\ntwo\nthree\nfour\nfive\n',
      facts: null,
      truncation: null,
      attachments: null,
      path: null,
    }),
  ]);

  const folded = bodyLines(base).map((row) => row.text);
  assert.match(folded[0] ?? '', /^╭─ ⏺ Bash 失败/);
  assert.match(folded[0] ?? '', /\[展开\]/);
  assert.match(folded.join('\n'), /上面还有 2 行/);
  assert.match(folded.join('\n'), /three/);
  assertCardWidths(bodyLines(base), 'tool folded');

  const expanded = bodyLines(toggleExpanded(base, 'c1'));
  assert.match(expanded.map((row) => row.text).join('\n'), /one/);
  assert.match(expanded[0]?.text ?? '', /\[收起\]/);
  assertCardWidths(expanded, 'tool expanded');
});

test('an edit shows its diff, because the request is in the log', () => {
  seq = 0;
  const before = 'const value = 1;\nexport { value };\n';
  const after = 'const value = 2;\nexport { value };\n';
  const view = viewOf([
    event('model.message', {
      text: '',
      toolCalls: [{ callId: 'c1', name: 'Edit', input: { file_path: '/work/a.ts', old_string: before, new_string: after } }],
      reasoning: [],
      stopReason: null,
    }),
    event('tool.finished', {
      callId: 'c1',
      name: 'Edit',
      ok: true,
      output: 'updated /work/a.ts',
      facts: null,
      truncation: null,
      attachments: null,
      path: '/work/a.ts',
    }),
  ]);

  const text = bodyLines(view).map((row) => row.text).join('\n');
  // The title bar carries the counts, and the body carries the hunks — old number, sign, text.
  assert.match(text, /\+1 -1/);
  assert.match(text, /@@ -1,2 \+1,2 @@/);
  assert.match(text, /\s1 - const value = 1;/);
  assert.match(text, /\s1 \+ const value = 2;/);
  assertCardWidths(bodyLines(view), 'diff card');
});

test('a pending approval is a card with the quip, the rule and the keys; ten seconds later it nudges', () => {
  seq = 0;
  const asked = viewOf([
    // Chinese, because the copy follows the user's language and these assertions are about it.
    event('turn.opened', { input: '清一下构建目录' }),
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }),
  ]);

  const fresh = frameOf(asked, { width: WIDTH, now: 1_000 });
  const freshText = fresh.body.map((row) => row.text).join('\n');
  assert.match(freshText, /^╭─ ⚠ Bash/m);
  assert.match(freshText, /\[待回答\]/);
  assert.match(freshText, /我要跑这个了/);
  assert.match(freshText, /规则：exec-asks/);
  assert.match(freshText, /y = 允许/);
  assert.doesNotMatch(freshText, /你还在吗/);
  assertCardWidths(fresh.body, 'approval fresh');
  // The keys are on the input line, so the card needs no room for them twice.
  assert.match(fresh.placeholder, /Bash：y = 允许/);

  const nudged = frameOf(asked, { width: WIDTH, now: 1_000 + 10_001 });
  assert.match(nudged.body.map((row) => row.text).join('\n'), /你还在吗/);
  // Without a width the status line is not truncated — 48 cells is where the nudge falls off.
  assert.match(statusLine(asked, { now: 11_001 }).text, /你还在吗/);
});

test('an answered approval says what happened', () => {
  seq = 0;
  const view = viewOf([
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }),
    event('approval.answered', { callId: 'c7', key: 'k', verdict: 'reject', by: 'user' }),
  ]);
  const text = bodyLines(view).map((row) => row.text).join('\n');
  assert.match(text, /\[已答\]/);
  assert.match(text, /行吧，这条不干。/);
});

test('the todo panel shows what is happening now, not just the plan', () => {
  seq = 0;
  const view = viewOf([
    event('todo.updated', {
      todos: [
        { content: '加输入校验', status: 'in_progress', activeForm: '在加输入校验' },
        { content: '写测试', status: 'pending', activeForm: '在写测试' },
        { content: '跑一遍', status: 'completed', activeForm: '在跑' },
      ],
    }),
  ]);
  const text = bodyLines(view).map((row) => row.text).join('\n');
  assert.match(text, /待办 1\/3/);
  assert.match(text, /\[▸\] 在加输入校验/);
  assert.match(text, /\[ \] 写测试/);
  assert.match(text, /\[x\] 跑一遍/);

  // Hidden on request, without touching the log.
  const hidden = frameOf({ ...view, todosVisible: false }, { width: WIDTH, now: 0 }).body.map((row) => row.text).join('\n');
  assert.doesNotMatch(hidden, /待办 1\/3/);
});

test('the palette draws the same table the /commands run through', () => {
  const lines = paletteLines(COMMANDS, 1, WIDTH).map((row) => row.text);
  assert.match(lines[0] ?? '', /^╭─ 命令/);
  assert.match(lines[0] ?? '', /↑↓ 选/);
  for (const command of COMMANDS) {
    assert.match(lines.join('\n'), new RegExp(`/${command.name}`));
  }
  // The selection is a character, not only an attribute: a snapshot can see it, and so can a
  // terminal with no colour.
  assert.match(lines[2] ?? '', /^│ ❯ \/expand/);
  assert.match(lines[1] ?? '', /^│ {3}\/todos/);
});

test('the status bar says where the session is, and truncates rather than wrapping', () => {
  seq = 0;
  const idle = viewOf([event('session.opened', { schemaVersion: 1, cowcatVersion: 'x', shell: { kind: 'posix', executable: '/bin/sh' } })]);
  assert.match(statusLine(idle).text, /sess_cards · 在。说正事吧。/);

  const wide = statusLine({ ...idle, closed: true }, { now: 0, width: 20 });
  assert.equal(stringWidth(wide.text), 20);

  const failed = statusLine(viewOf([event('turn.transitioned', { from: 'streaming', to: 'failed', reason: 'upstream 503' })]), { now: 0 });
  assert.match(failed.text, /刚才那步失败了。（upstream 503）/);
  assert.equal(failed.token, 'alert');
});
