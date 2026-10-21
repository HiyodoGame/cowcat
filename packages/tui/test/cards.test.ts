import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { initialView, toggleExpanded, toggleThinking, withAttachment, type TuiView } from '../src/app/view.js';
import { project } from '../src/app/project.js';
import { frameOf } from '../src/components/session-frame.js';
import { statusLine } from '../src/components/status-bar.js';
import { paletteLines } from '../src/components/palette.js';
import { COMMANDS } from '../src/app/commands.js';
import { stringWidth } from '../src/text/width.js';
import { imageBox } from '../src/image/layout.js';
import { line } from '../src/ui/line.js';
import type { Line } from '../src/ui/line.js';
import { PNG_BYTES } from './png.js';

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

test('a tool result is a card: status, tail, and a way to see the rest', () => {
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

  const folded = bodyLines(base);
  const foldedText = folded.map((row) => row.text).join('\n');
  assert.match(folded[0]?.text ?? '', /^╭─ ⏺ Bash 失败 \[展开\]/);
  assert.match(foldedText, /上面还有 2 行/);
  assert.match(foldedText, /three/);
  assertCardWidths(folded, 'tool folded');

  const expanded = bodyLines(toggleExpanded(base, 'c1'));
  const expandedText = expanded.map((row) => row.text).join('\n');
  assert.match(expanded[0]?.text ?? '', /\[收起\]/);
  assert.match(expandedText, /one/);
  assertCardWidths(expanded, 'tool expanded');
});

test('an attachment is a hole in the text plus a slot, and it says what it is at every stage', () => {
  seq = 0;
  const asked = viewOf([
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Read', input: { file_path: '/work/a.png' } }], reasoning: [], stopReason: null }),
    event('tool.finished', {
      callId: 'c1',
      name: 'Read',
      ok: true,
      output: 'read a.png (image, 320x200)',
      facts: null,
      truncation: null,
      attachments: [{ type: 'image', mediaType: 'image/png', path: '/work/a.png', bytes: 83, width: 320, height: 200, pages: null }],
      path: '/work/a.png',
    }),
  ]);

  // 1. The log only has the REFERENCE, so the card says it is fetching (ADR-057).
  const loading = frameOf(asked, { width: WIDTH, now: 0 });
  assert.match(loading.body.map((row) => row.text).join('\n'), /图片 image\/png 320×200 — 正在取字节…/);
  assert.equal(loading.images?.length, 0);
  assertCardWidths(loading.body, 'attachment loading');

  // 2. The bytes arrived: the card reserves rows and hands the pixels to the screen.
  const ready = withAttachment(asked, {
    path: '/work/a.png',
    mediaType: 'image/png',
    width: 320,
    height: 200,
    pages: null,
    status: 'ready',
    bytes: PNG_BYTES,
    reason: null,
  });
  const framed = frameOf(ready, { width: WIDTH, now: 0 });
  assert.match(framed.body.map((row) => row.text).join('\n'), /图片 image\/png 320×200/);
  const slot = framed.images?.[0];
  assert.ok(slot !== undefined, 'a ready attachment becomes an image slot');
  // 320×200 in 44 columns would want 44 columns and 14 rows, which is over the inline budget
  // (12), so the box shrinks keeping the ratio: 12 rows × 2 cells ≈ 38 columns.
  assert.equal(slot.rows, 12, 'the row budget caps an inline image');
  assert.equal(slot.cols, 38);
  assert.equal(slot.left, 2, 'a card image starts after the `│ ` frame');
  assert.equal(slot.source.byteLength, 83);
  // The rows it occupies are card rows, so the text below it cannot be drawn over the image.
  for (let index = 0; index < slot.rows; index += 1) {
    assert.match(framed.body[slot.row + index]?.text ?? 'x', /^│\s*│$/, `row ${String(index)} of the image is a card row`);
  }
  assertCardWidths(framed.body, 'attachment ready');

  // 3. Refused: the reason is shown, and there is no hole pretending to be a picture.
  const failed = withAttachment(asked, {
    path: '/work/a.png',
    mediaType: 'image/png',
    width: 320,
    height: 200,
    pages: null,
    status: 'failed',
    bytes: null,
    reason: 'attachment /work/a.png is 24000000 bytes, over the 20000000 byte limit',
  });
  const bad = frameOf(failed, { width: WIDTH, now: 0 });
  // The reason is the host's own sentence, truncated to the card — the point is that it is
  // shown at all, rather than a silent blank where a picture was promised.
  assert.match(bad.body.map((row) => row.text).join('\n'), /取不到：attachment/);
  assert.equal(bad.images?.length, 0);
  assertCardWidths(bad.body, 'attachment failed');
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
  assert.match(freshText, /允许一次/);
  assert.match(freshText, /本会话内 Bash 都不再问/u);
  assert.match(freshText, /▸ 允许一次/);
  assert.doesNotMatch(freshText, /你还在吗/);
  assertCardWidths(fresh.body, 'approval fresh');
  // The keys are on the input line, so the card needs no room for them twice.
  assert.match(fresh.placeholder, /Bash：↑↓ 选择/u);

  // The highlight is a view field, so the frame is a pure function of it too.
  const moved = frameOf({ ...asked, approvalCursor: 2 }, { width: WIDTH, now: 1_000 });
  assert.match(moved.body.map((row) => row.text).join('\n'), /▸ 只对这一个动作/u);

  const nudged = frameOf(asked, { width: WIDTH, now: 1_000 + 10_001 });
  assert.match(nudged.body.map((row) => row.text).join('\n'), /你还在吗/);
  // Without a width the status line is not truncated — 48 cells is where the nudge falls off.
  assert.match(statusLine(asked, { now: 11_001 }).text, /你还在吗/);
});

test('a destructive command gets its own line, in the alert token', () => {
  seq = 0;
  const asked = viewOf([
    event('turn.opened', { input: '停掉线上站点' }),
    event('approval.requested', {
      callId: 'c7',
      name: 'Bash',
      rule: 'no-rule-matched',
      reason: 'no rule covers Bash',
      warning: '删除远端项目（不可逆，域名与部署历史随之消失）',
    }),
  ]);

  const frame = frameOf(asked, { width: WIDTH, now: 1_000 });
  assert.match(frame.body.map((row) => row.text).join('\n'), /注意：删除远端项目/);
  // The one line meant to interrupt a habitual "y" must not be dim like the rule row.
  const warning = frame.body.find((row) => row.text.includes('注意：'));
  assert.ok(warning !== undefined);
  assert.equal(warning.token, 'alert');
  assertCardWidths(frame.body, 'approval warning');
});

test('thinking is one collapsed line until it is expanded', () => {
  seq = 0;
  const base = viewOf([
    event('turn.opened', { input: '解释一下这个函数' }),
    event('model.message', {
      text: '它是把数组拼成路径。',
      toolCalls: [],
      reasoning: [{ type: 'thinking', text: '先看 joinPath 的实现，再看调用点。', signature: 's' }],
      stopReason: null,
    }),
  ]);

  const collapsed = frameOf(base, { width: WIDTH, now: 1_000 });
  const collapsedText = collapsed.body.map((row) => row.text).join('\n');
  assert.match(collapsedText, /思考 · 1 段（Ctrl-T 展开）/u);
  assert.doesNotMatch(collapsedText, /先看 joinPath 的实现/u);

  const expanded = frameOf(toggleThinking(base), { width: WIDTH, now: 1_000 });
  const expandedText = expanded.body.map((row) => row.text).join('\n');
  assert.match(expandedText, /思考 · 1 段（Ctrl-T 折叠）/u);
  assert.match(expandedText, /先看 joinPath 的实现/u);
});

test('the input line hints at / commands as they are typed', () => {
  const empty = frameOf({ ...initialView(), input: '/' }, { width: WIDTH, now: 1_000 });
  assert.match(empty.placeholder, /\/todos/u);
  assert.match(empty.placeholder, /共 7 个/u);

  const narrowed = frameOf({ ...initialView(), input: '/th' }, { width: WIDTH, now: 1_000 });
  assert.match(narrowed.placeholder, /\/thinking/u);
  assert.doesNotMatch(narrowed.placeholder, /\/todos/u);

  const nothing = frameOf({ ...initialView(), input: '/nope' }, { width: WIDTH, now: 1_000 });
  assert.match(nothing.placeholder, /没有这个命令/u);
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

test('an image box keeps its ratio until the row budget says otherwise', () => {
  // Wide image: the columns are the limit.
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: 100, height: 40 }), { cols: 44, rows: 9 });
  // Tall image: the rows are, and shrinking keeps the ratio.
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: 200, height: 400 }), { cols: 12, rows: 12 });
  // Nobody measured it: a shape, not a guess about the contents.
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: null, height: null }), { cols: 24, rows: 8 });
  // A tiny square image is not stretched, and it is still two rows: four columns of cells are
  // twice as tall as the four pixels were wide.
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: 4, height: 4 }), { cols: 4, rows: 2 });
});

test('the status bar says what is running, and counts running sub-agents', () => {
  const running: TuiView = {
    ...initialView(),
    sessionId: 'sess_run',
    turn: { id: 'turn_1', state: 'awaiting_tools', reason: null },
    pendingTools: [{ callId: 'c1', name: 'Bash' }],
  };
  const line = statusLine(running, { now: 0 });
  assert.match(line.text, /执行 Bash/u);
  assert.equal(line.token, 'act');
  // The spinner cell is a function of the clock, not of the process.
  assert.notEqual(statusLine(running, { now: 0 }).text, statusLine(running, { now: 300 }).text);

  const withAgent: TuiView = {
    ...running,
    agents: [
      {
        childSessionId: 'sess_child',
        role: 'explore',
        description: '看 src 目录',
        state: 'running',
        turns: 2,
        startedAt: 0,
      },
    ],
  };
  assert.match(statusLine(withAgent, { now: 1_000 }).text, /子 agent 1 个运行中/u);

  const idle = statusLine({ ...initialView(), sessionId: 'sess_idle' }, { now: 0 });
  assert.doesNotMatch(idle.text, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/u, 'no spinner when nothing is running');
});

test('a running sub-agent is a panel; a finished one collapses to its notice', () => {
  const view = viewOf([
    event('turn.opened', { input: '派一个子 agent' }),
    event('subagent.started', {
      callId: 'c1',
      childSessionId: 'sess_child',
      role: 'explore',
      description: '看 src 目录',
    }),
  ]);
  const frame = frameOf(view, { width: WIDTH, now: 5_000 });
  const text = frame.body.map((row) => row.text).join('\n');
  assert.match(text, /子 agent 1 个运行中/u);
  assert.match(text, /explore/u);
  assert.match(text, / · \d+s/u);

  const done = project(
    view,
    event('subagent.finished', {
      callId: 'c1',
      childSessionId: 'sess_child',
      role: 'explore',
      ok: true,
      state: 'completed',
      turns: 3,
      partial: false,
      usage: null,
      reason: null,
    }),
  );
  assert.equal(done.agents[0]?.state, 'completed');
  assert.doesNotMatch(
    frameOf(done, { width: WIDTH, now: 5_000 }).body.map((row) => row.text).join('\n'),
    /个运行中/u,
    'the panel is for running agents only',
  );
});

test('a pending tool is named until its result arrives', () => {
  const asked = viewOf([
    event('turn.opened', { input: '跑测试' }),
    event('model.message', {
      text: '',
      toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'npm test' } }],
      reasoning: [],
      stopReason: null,
    }),
  ]);
  assert.deepEqual(asked.pendingTools, [{ callId: 'c1', name: 'Bash' }]);

  const finished = project(
    asked,
    event('tool.finished', {
      callId: 'c1',
      name: 'Bash',
      ok: true,
      output: 'ok',
      facts: null,
      truncation: null,
      path: null,
      attachments: null,
    }),
  );
  assert.deepEqual(finished.pendingTools, []);
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
