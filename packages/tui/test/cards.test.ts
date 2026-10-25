import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { initialView, toggleExpanded, toggleThinking, withAttachment, type TuiView } from '../src/app/view.js';
import { project } from '../src/app/project.js';
import { frameOf } from '../src/components/session-frame.js';
import { statusLine } from '../src/components/status-bar.js';
import { taskPanelLines } from '../src/components/task-panel.js';
import { paletteLines } from '../src/components/palette.js';
import { COMMANDS, slashMatches } from '../src/app/commands.js';
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
  const frame = frameOf(view, { width: WIDTH, now: 1_000 });
  // Fixed panels live in the dock now; tests that talk about what is on screen want both.
  return [...frame.body, ...(frame.dock ?? [])];
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
  const freshDock = fresh.dock ?? [];
  const freshText = freshDock.map((row) => row.text).join('\n');
  assert.match(freshText, /^╭─ ⚠ Bash/m);
  assert.match(freshText, /\[待回答\]/);
  assert.match(freshText, /我要跑这个了/);
  assert.match(freshText, /规则：exec-asks/);
  assert.match(freshText, /允许一次/);
  assert.match(freshText, /本会话内 Bash 都不再问/u);
  assert.match(freshText, /▸ 允许一次/);
  assert.doesNotMatch(freshText, /你还在吗/);
  assertCardWidths(freshDock, 'approval fresh');
  // The keys are on the input line, so the card needs no room for them twice.
  assert.match(fresh.placeholder, /Bash：↑↓ 选择/u);

  // The highlight is a view field, so the frame is a pure function of it too.
  const moved = frameOf({ ...asked, approvalCursor: 2 }, { width: WIDTH, now: 1_000 });
  assert.match((moved.dock ?? []).map((row) => row.text).join('\n'), /▸ 只对这一个动作/u);

  const nudged = frameOf(asked, { width: WIDTH, now: 1_000 + 10_001 });
  assert.match((nudged.dock ?? []).map((row) => row.text).join('\n'), /你还在吗/);
  // Without a width the status line is not truncated — 48 cells is where the nudge falls off.
  assert.match(statusLine(asked, { now: 11_001 }).text, /你还在吗/);
});

test('an escalation card leads with the exact subject and says what would widen', () => {
  seq = 0;
  const asked = viewOf([
    event('turn.opened', { input: '跑一下被拒绝的命令' }),
    event('approval.requested', {
      callId: 'c8',
      name: 'Bash',
      rule: 'escalation',
      reason: '构建需要这条命令',
      command: 'npm run release',
      dimensions: ['deny-override'],
    }),
  ]);

  const dock = frameOf(asked, { width: WIDTH, now: 1_000 }).dock ?? [];
  const text = dock.map((row) => row.text).join('\n');
  // The subject leads (ADR-129 7): an answer grants THIS command, and the card must
  // say so before the model's own justification gets a line.
  const subjectAt = text.indexOf('npm run release');
  const reasonAt = text.indexOf('构建需要这条命令');
  const ruleAt = text.indexOf('规则：escalation');
  assert.ok(subjectAt >= 0 && reasonAt > subjectAt && ruleAt > subjectAt, 'subject first, reason and rule after it');
  assert.match(text, /将放宽：放行这条被规则拒绝的操作/);
});

test('an escalation card scrubs control characters out of model-written text', () => {
  seq = 0;
  const asked = viewOf([
    event('turn.opened', { input: 'x' }),
    event('approval.requested', {
      callId: 'c9',
      name: 'Bash',
      rule: 'escalation',
      reason: '看\u001B[31m起来无害',
      command: 'echo hi',
      dimensions: ['unsandboxed'],
    }),
  ]);

  const dock = frameOf(asked, { width: WIDTH, now: 1_000 }).dock ?? [];
  const text = dock.map((row) => row.text).join('\n');
  assert.doesNotMatch(text, //);
  assert.match(text, /看\[31m起来无害/);
  assert.match(text, /本次脱离沙箱执行/);
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
  const dock = frame.dock ?? [];
  assert.match(dock.map((row) => row.text).join('\n'), /注意：删除远端项目/);
  // The one line meant to interrupt a habitual "y" must not be dim like the rule row.
  const warning = dock.find((row) => row.text.includes('注意：'));
  assert.ok(warning !== undefined);
  assert.equal(warning.token, 'alert');
  assertCardWidths(dock, 'approval warning');
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

test('live thinking is visible before the answer arrives', () => {
  const frame = frameOf(
    { ...initialView(), reasoningStream: '先看调用点，再改实现。', reasoningShown: 999 },
    { width: WIDTH, now: 1_000 },
  );
  const text = frame.body.map((row) => row.text).join('\n');
  assert.match(text, /思考中/u);
  assert.match(text, /先看调用点/u);
});

test('a running tool is a card with an animated marker and its command', () => {
  const view = viewOf([
    event('turn.opened', { input: '跑测试' }),
    event('model.message', {
      text: '',
      toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'npm test --watch' } }],
      reasoning: [],
      stopReason: null,
    }),
  ]);

  const at0 = frameOf(view, { width: WIDTH, now: 0 }).body.map((row) => row.text).join('\n');
  assert.match(at0, /Bash/u);
  assert.match(at0, /运行中/u);
  assert.match(at0, /npm test --watch/u);

  const at150 = frameOf(view, { width: WIDTH, now: 150 }).body.map((row) => row.text).join('\n');
  assert.notEqual(at150, at0, 'the marker is a function of the clock');
});

test('the input line hints at / commands as they are typed', () => {
  const empty = frameOf({ ...initialView(), input: '/' }, { width: WIDTH, now: 1_000 });
  assert.match(empty.placeholder, /\/todos/u);
  assert.match(empty.placeholder, /共 24 个/u);

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
  // The card is windowed around the selection (24 commands never fit the dock budget), so
  // a top-of-table selection shows the first WINDOW rows; `/quit` (index 11) is below it.
  for (const command of COMMANDS.slice(0, 7)) {
    assert.match(lines.join('\n'), new RegExp(`/${command.name}`));
  }
  assert.doesNotMatch(lines.join('\n'), /\/quit/);
  // The selection is a character, not only an attribute: a snapshot can see it, and so can a
  // terminal with no colour.
  assert.match(lines[2] ?? '', /^│ ❯ \/expand/);
  assert.match(lines[1] ?? '', /^│ {3}\/todos/);
});

test('the palette window follows the selection instead of freezing above the fold', () => {
  // Selecting the last row scrolls the window to the tail: the marker stays visible, the
  // click id stays the absolute row, and the rows that scrolled out are gone.
  const last = COMMANDS.length - 1;
  const lastName = COMMANDS[last]?.name ?? '';
  const tail = paletteLines(COMMANDS, last, WIDTH);
  const tailText = tail.map((row) => row.text).join('\n');
  assert.match(tailText, new RegExp(`❯ /${lastName}`));
  assert.equal(tail.find((row) => row.hit === `palette:${String(last)}`)?.text.includes('❯'), true);
  assert.doesNotMatch(tailText, /\/todos/);
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
    turn: { id: 'turn_1', state: 'awaiting_tools', reason: null, cronSourced: false },
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

test('a running tool card shows the live tail, capped at twenty rows (ADR-109)', () => {
  const base: TuiView = {
    ...initialView(),
    turn: { id: 'turn_1', state: 'awaiting_tools', reason: null, cronSourced: false },
    pendingTools: [{ callId: 'c1', name: 'Bash' }],
    calls: { c1: { name: 'Bash', input: { command: 'pnpm build' } } },
  };

  const withTail = frameOf({ ...base, toolOutput: { c1: { text: 'first\nsecond', truncated: false } } }, { width: WIDTH, now: 0 });
  const text = withTail.body.map((row) => row.text).join('\n');
  assert.match(text, /pnpm build/u);
  assert.match(text, /first/u);
  assert.match(text, /second/u);

  const many = Array.from({ length: 30 }, (_, index) => `row${String(index)}`).join('\n');
  const capped = frameOf({ ...base, toolOutput: { c1: { text: many, truncated: false } } }, { width: WIDTH, now: 0 });
  const cappedText = capped.body.map((row) => row.text).join('\n');
  assert.match(cappedText, /row29/u, 'the newest rows are the ones kept');
  assert.doesNotMatch(cappedText, /row0/u);
  assert.match(cappedText, /上面还有 10 行/u);

  // When the character cap already dropped output, a line count would understate what was
  // lost: the card says the honest thing instead (ADR-109).
  const truncated = frameOf({ ...base, toolOutput: { c1: { text: many, truncated: true } } }, { width: WIDTH, now: 0 });
  const truncatedText = truncated.body.map((row) => row.text).join('\n');
  assert.match(truncatedText, /只显示末尾输出/u);
  assert.doesNotMatch(truncatedText, /上面还有/u);
});

test('the /tasks panel lists background tasks and the status bar counts the running ones (ADR-113)', () => {
  const view: TuiView = {
    ...initialView(),
    sessionId: 'sess_bg',
    turn: { id: 'turn_1', state: 'streaming', reason: null, cronSourced: false },
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
      {
        taskId: 'bg_a_2',
        callId: 'c2',
        command: 'pnpm test',
        startedAt: 0,
        startedSeq: 3,
        state: 'exited',
        endedAt: 5_000,
        exitCode: 1,
      },
    ],
    taskPanel: { index: 1 },
  };

  const frame = frameOf(view, { width: WIDTH, now: 12_000 });
  const dock = (frame.dock ?? []).map((row) => row.text).join('\n');
  assert.match(dock, /后台任务（2）/u);
  assert.match(dock, /运行中 12s/u);
  assert.match(dock, /已结束\(1\)/u);
  assert.match(dock, /pnpm dev/u);
  // The cursor is on the second row; the marker follows the view, not the array order.
  assert.equal((frame.dock ?? []).find((row) => row.text.includes('pnpm test'))?.text.startsWith('▸'), true);

  assert.match(statusLine(view, { now: 12_000 }).text, /后台 1/u);
});

test('the task panel window follows the cursor instead of always showing the first rows (ADR-113)', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    taskId: `bg_a_${String(index + 1)}`,
    callId: 'c1',
    command: `cmd ${String(index + 1)}`,
    startedAt: 0,
    startedSeq: index + 2,
    state: 'running' as const,
    endedAt: null,
    exitCode: null,
  }));
  const text = taskPanelLines(tasks, 7, 80, 0)
    .map((row) => row.text)
    .join('\n');
  assert.match(text, /bg_a_8/u, 'the selected task is visible');
  assert.doesNotMatch(text, /bg_a_1\b/u, 'the window scrolled past the first rows');
});

test('a finished card wraps its output without losing two cells to the frame (issue #134)', () => {
  const output = 'a'.repeat(100);
  const view = viewOf([
    event('turn.opened', { input: 'run it' }),
    event('tool.finished', {
      callId: 'c1',
      name: 'Bash',
      ok: true,
      output,
      facts: null,
      truncation: null,
      attachments: null,
      path: null,
    }),
  ]);
  const frame = frameOf(view, { width: 40, now: 0 });
  const rows = frame.body.map((row) => row.text);
  // 40 columns − 4 of card frame − 2 of indent = 34 characters on a full row.
  assert.ok(
    rows.some((row) => row.includes('a'.repeat(34))),
    'a full row keeps all 34 cells; before the fix padTo cut it to 33 plus an ellipsis',
  );
  assert.equal(
    rows.some((row) => row.includes('…')),
    false,
    'no row is truncated by the card padding',
  );
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
  const text = (frame.dock ?? []).map((row) => row.text).join('\n');
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
    (frameOf(done, { width: WIDTH, now: 5_000 }).dock ?? []).map((row) => row.text).join('\n'),
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

test('clickable rows carry a hit id for the loop to decode', () => {
  const approvalView = viewOf([
    event('turn.opened', { input: '清一下构建目录' }),
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }),
  ]);
  const approvalFrame = frameOf(approvalView, { width: WIDTH, now: 1_000 });
  const option = (approvalFrame.dock ?? []).find((row) => row.text.includes('允许一次'));
  assert.equal(option?.hit, 'approval:0');
  const session = (approvalFrame.dock ?? []).find((row) => row.text.includes('本会话内 Bash'));
  assert.equal(session?.hit, 'approval:1');

  const toolView = viewOf([
    event('turn.opened', { input: '看一眼' }),
    event('model.message', {
      text: '',
      toolCalls: [{ callId: 'call_1', name: 'Read', input: { file_path: '/a.txt' } }],
      reasoning: [],
      stopReason: null,
    }),
    event('tool.finished', {
      callId: 'call_1',
      name: 'Read',
      ok: true,
      output: 'hello',
      facts: null,
      truncation: null,
      path: '/a.txt',
      attachments: null,
    }),
  ]);
  const toolFrame = frameOf(toolView, { width: WIDTH, now: 1_000 });
  const toolRow = toolFrame.body.find((row) => row.text.includes('Read'));
  assert.equal(toolRow?.hit, 'tool:call_1');

  // The scroll offset is part of the frame spec, so a snapshot can pin it.
  assert.equal(frameOf({ ...approvalView, scrollOffset: 7 }, { width: WIDTH, now: 0 }).scroll, 7);
});

test('the / menu is a selectable list in the dock, not a placeholder', () => {
  const view = { ...initialView(), input: '/' };
  const frame = frameOf(view, { width: WIDTH, now: 1_000 });
  const dock = frame.dock ?? [];
  const text = dock.map((row) => row.text).join('\n');
  assert.match(text, /命令/u);
  assert.match(text, /\/todos/u);
  assert.match(text, /▸ \/todos/u);
  // A row click runs that command, so the id is on the card row. The menu is windowed, so
  // `/cron` (index 6, after tasks) is the last row that fits; `/quit` is below the fold.
  assert.equal(dock.find((row) => row.text.includes('/cron'))?.hit, 'slash:6');

  const moved = frameOf({ ...view, slashIndex: 2 }, { width: WIDTH, now: 1_000 });
  assert.match((moved.dock ?? []).map((row) => row.text).join('\n'), /▸ \/cancel/u);

  // The window follows the selection: arrowing to `/changes` (index 12) scrolls the top
  // out of view instead of moving the marker below the fold, and the click id stays absolute.
  const followed = frameOf({ ...view, slashIndex: 12 }, { width: WIDTH, now: 1_000 });
  const followedDock = followed.dock ?? [];
  const followedText = followedDock.map((row) => row.text).join('\n');
  assert.match(followedText, /▸ \/changes/u);
  assert.doesNotMatch(followedText, /\/todos/u);
  assert.equal(followedDock.find((row) => row.hit === 'slash:12')?.text.includes('▸'), true);

  // A space closes the menu: Enter means "send this prompt" again.
  assert.deepEqual(slashMatches('/help me'), []);
});

test('the status line names the model and counts seconds', () => {
  const view: TuiView = {
    ...initialView(),
    sessionId: 'sess_status',
    model: 'zai-coding-plan/glm-5.3-flash',
    turn: { id: 'turn_1', state: 'streaming', reason: null, cronSourced: false },
    turnStartedAt: 0,
  };
  const line = statusLine(view, { now: 12_000 });
  assert.match(line.text, /glm-5\.3-flash/u);
  assert.match(line.text, /12s/u);
  assert.doesNotMatch(line.text, /zai-coding-plan\//u);

  const paused = statusLine({ ...view, scrollOffset: 5, newSinceScroll: 3 }, { now: 12_000 });
  assert.match(paused.text, /已暂停跟随/u);
  assert.match(paused.text, /3 条新输出/u);
});

test('the status line shows how full the context is, and stays quiet when the window is unknown', () => {
  const view: TuiView = {
    ...initialView(),
    sessionId: 'sess_ctx',
    contextWindow: 200_000,
    // A cached prompt: `input` alone is 4k, the request really carried 84.2k. Summing the
    // cache fields is the difference between "2%" and the truth (ADR-105 ②).
    usage: { input: 4_000, output: 200, cacheRead: 80_000, cacheCreation: 0 },
  };
  assert.match(statusLine(view, { now: 0 }).text, /ctx 42%/u);
  assert.doesNotMatch(statusLine(view, { now: 0 }).text, /ctx 2%/u);

  // An older log (or a preset with no window) has no denominator: no claim, not 0%.
  assert.doesNotMatch(statusLine({ ...view, contextWindow: null }, { now: 0 }).text, /ctx \d+%/u);
  // Nothing measured yet: nothing to divide.
  assert.doesNotMatch(statusLine({ ...view, usage: null }, { now: 0 }).text, /ctx \d+%/u);
});

test('a paused transcript offers a clickable way back to the bottom (ADR-105)', () => {
  const paused = { ...initialView(), scrollOffset: 4, newSinceScroll: 3 };
  const dock = frameOf(paused, { width: WIDTH, now: 0 }).dock ?? [];
  const row = dock.find((line) => line.hit === 'scroll:bottom');
  assert.match(row?.text ?? '', /回到底部/u);
  assert.match(row?.text ?? '', /3 条新输出/u);

  // Following the tail: the button would be chrome on a screen that needs nothing from it.
  const following = frameOf(initialView(), { width: WIDTH, now: 0 }).dock ?? [];
  assert.equal(following.some((line) => line.hit === 'scroll:bottom'), false);

  // The dock is capped at 40% of the terminal (never below 3 rows). The button is first, so
  // a menu or a long todo list cannot push it out (ADR-105 ③).
  const cramped = frameOf({ ...paused, input: '/' }, { width: WIDTH, height: 6, now: 0 }).dock ?? [];
  assert.equal(cramped[0]?.hit, 'scroll:bottom');

  // A question outranks navigation: one row, and the answer is what the screen is about.
  const asking = viewOf([
    event('turn.opened', { input: '清一下构建目录' }),
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }),
  ]);
  const askingDock = frameOf({ ...asking, scrollOffset: 4, newSinceScroll: 2 }, { width: WIDTH, now: 0 }).dock ?? [];
  assert.equal(askingDock.some((line) => line.hit === 'scroll:bottom'), false);
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

test('an answered approval keeps the / menu visible; a pending one hides it', () => {
  // project.ts keeps an answered card on screen until the turn ends — a record, not a
  // question. The menu suppressed under it forever was the reported "typing / again did
  // nothing after answering".
  const approval = {
    callId: 'c1',
    name: 'Bash',
    rule: 'no-rule-matched',
    reason: null,
    warning: null,
    command: null,
    path: null,
    dimensions: [] as never[],
    askedAt: 0,
    verdict: null as string | null,
    by: null as string | null,
  };
  const pending = frameOf({ ...initialView(), approval, input: '/' }, { width: WIDTH, now: 0 }).dock ?? [];
  assert.doesNotMatch(pending.map((row) => row.text).join('\n'), /\/todos/u);
  const answered = frameOf(
    { ...initialView(), approval: { ...approval, verdict: 'once', by: 'user' }, input: '/' },
    { width: WIDTH, now: 0 },
  ).dock ?? [];
  assert.match(answered.map((row) => row.text).join('\n'), /\/todos/u);
});
