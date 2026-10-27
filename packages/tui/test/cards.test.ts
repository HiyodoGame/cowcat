import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { initialView, toggleExpanded, toggleThinking, withAttachment, type TuiView } from '../src/app/view.js';
import { project } from '../src/app/project.js';
import { frameOf } from '../src/components/session-frame.js';
import { statusBar } from '../src/components/status-bar.js';
import { taskPanel } from '../src/components/task-panel.js';
import { commandPalette } from '../src/components/palette.js';
import { COMMANDS, slashMatches } from '../src/app/commands.js';
import { stringWidth } from '../src/text/width.js';
import { imageBox } from '../src/image/layout.js';
import type { Line } from '../src/ui/line.js';
import { PNG_BYTES } from './png.js';
import { nodesOf, rowsOf, textOf } from './scene.js';

const WIDTH = 48;
let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1_000, sessionId: 'sess_cards', turnId: 'turn_1', type, ...body };
}
function viewOf(events: readonly WireEvent[]): TuiView { return events.reduce(project, initialView()); }
function bodyLines(view: TuiView): readonly Line[] {
  const frame = frameOf(view, { width: WIDTH, now: 1_000 });
  return rowsOf([...frame.body, ...(frame.dock ?? [])]);
}
function assertTextFits(lines: readonly Line[], label: string): void {
  for (const [index, row] of lines.entries()) assert.ok(stringWidth(row.text) <= WIDTH, `${label}: row ${String(index)} is too wide`);
}
function toolResult(output = 'one\ntwo\nthree\nfour\nfive\n'): TuiView {
  return viewOf([
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'npm test' } }], reasoning: [], stopReason: null }),
    event('tool.finished', { callId: 'c1', name: 'Bash', ok: false, output, facts: null, truncation: null, attachments: null, path: null }),
  ]);
}

test('the user message is a native panel with wrapped text, not drawn borders', () => {
  seq = 0;
  const frame = frameOf(viewOf([event('turn.opened', { input: '把 value 改成 total 并且顺手把那三个 helper 也重命名一下，顺便补上注释' })]), { width: WIDTH, now: 0 });
  const card = frame.body[0];
  assert.equal(card?.kind, 'panel');
  assert.equal(card?.kind === 'panel' && card.title, '你');
  assert.ok(bodyLines(viewOf([event('turn.opened', { input: '中文长文本，需要在原生面板内部换行，而不是画出右边框' })])).length >= 2);
  assertTextFits(bodyLines(viewOf([event('turn.opened', { input: '把 value 改成 total' })])), 'user');
});

test('the assistant uses the default text voice and keeps its tool count', () => {
  seq = 0;
  const lines = bodyLines(viewOf([event('model.message', { text: '改好了。', toolCalls: [{ callId: 'c1', name: 'Read', input: {} }], reasoning: [], stopReason: null })]));
  assert.equal(lines[0]?.text, '改好了。');
  assert.equal(lines[0]?.runs?.[0]?.token, 'text');
  assert.match(textOf([...frameOf(viewOf([event('model.message', { text: '改好了。', toolCalls: [{}], reasoning: [] })]), { width: WIDTH, now: 0 }).body]), /带了 1 个工具调用/);
});

test('tool results keep status, output tail and expansion in an accent component', () => {
  seq = 0;
  const base = toolResult();
  const folded = bodyLines(base);
  assert.match(folded[0]?.text ?? '', /^Bash {2}失败/);
  assert.match(folded[0]?.text ?? '', /展开/);
  assert.match(textOf(frameOf(base, { width: WIDTH, now: 0 }).body), /上面还有 2 行/);
  assert.match(textOf(frameOf(base, { width: WIDTH, now: 0 }).body), /three/);
  assert.equal(frameOf(base, { width: WIDTH, now: 0 }).body[0]?.kind, 'block');
  const expanded = textOf(frameOf(toggleExpanded(base, 'c1'), { width: WIDTH, now: 0 }).body);
  assert.match(expanded, /收起/);
  assert.match(expanded, /one/);
  assertTextFits(bodyLines(base), 'tool');
});

test('attachments are native image nodes with loading and error alternatives', () => {
  seq = 0;
  const asked = viewOf([
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Read', input: { file_path: '/work/a.png' } }], reasoning: [], stopReason: null }),
    event('tool.finished', { callId: 'c1', name: 'Read', ok: true, output: 'read a.png', facts: null, truncation: null, attachments: [{ type: 'image', mediaType: 'image/png', path: '/work/a.png', bytes: 83, width: 320, height: 200, pages: null }], path: '/work/a.png' }),
  ]);
  assert.match(textOf(frameOf(asked, { width: WIDTH, now: 0 }).body), /正在取字节/);
  const ready = withAttachment(asked, { path: '/work/a.png', mediaType: 'image/png', width: 320, height: 200, pages: null, status: 'ready', bytes: PNG_BYTES, reason: null });
  const image = nodesOf(frameOf(ready, { width: WIDTH, now: 0 }).body).find((node) => node.kind === 'image');
  assert.ok(image !== undefined);
  assert.equal(image.kind === 'image' && image.image.rows, 12);
  assert.equal(image.kind === 'image' && image.image.cols, 38);
  assert.equal(image.kind === 'image' && image.image.source.byteLength, 83);
  const card = frameOf(ready, { width: WIDTH, now: 0 }).body[0];
  assert.equal(card?.kind, 'block');
  if (card?.kind === 'block') {
    const imageAt = card.children.findIndex((node) => node.kind === 'image');
    const labelAt = card.children.findIndex((node) => node.kind === 'text' && node.rows.some((row) => row.text.includes('图片')));
    assert.ok(labelAt >= 0 && labelAt < imageAt, 'the attachment caption precedes its image');
  }
  const failed = withAttachment(asked, { path: '/work/a.png', mediaType: 'image/png', width: 320, height: 200, pages: null, status: 'failed', bytes: null, reason: 'too large' });
  assert.match(textOf(frameOf(failed, { width: WIDTH, now: 0 }).body), /取不到：too large/);
  assert.equal(nodesOf(frameOf(failed, { width: WIDTH, now: 0 }).body).some((node) => node.kind === 'image'), false);
});

test('diff content keeps its signs and counts while the card chrome is native', () => {
  seq = 0;
  const view = viewOf([
    event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Edit', input: { file_path: '/work/a.ts', old_string: 'const value = 1;\nexport { value };\n', new_string: 'const value = 2;\nexport { value };\n' } }], reasoning: [], stopReason: null }),
    event('tool.finished', { callId: 'c1', name: 'Edit', ok: true, output: 'updated', facts: null, truncation: null, attachments: null, path: '/work/a.ts' }),
  ]);
  const text = textOf(frameOf(view, { width: WIDTH, now: 0 }).body);
  assert.match(text, /\+1 -1/);
  assert.match(text, /@@ -1,2 \+1,2 @@/);
  assert.match(text, /\s1 - const value = 1;/);
  assert.match(text, /\s1 \+ const value = 2;/);
});

test('approval choices are selected native rows and preserve the exact subject', () => {
  seq = 0;
  const asked = viewOf([
    event('turn.opened', { input: '清一下构建目录' }),
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'escalation', reason: '构建需要这条命令', command: 'npm run release', dimensions: ['deny-override'], warning: '删除远端项目（不可逆）' }),
  ]);
  const frame = frameOf(asked, { width: WIDTH, now: 1_000 });
  const card = frame.dock?.[0];
  assert.equal(card?.kind, 'panel');
  assert.equal(card?.kind === 'panel' && card.title, 'Bash · 待回答');
  const text = textOf(frame.dock ?? []);
  assert.ok(text.indexOf('npm run release') < text.indexOf('构建需要这条命令'));
  assert.match(text, /将放宽：放行这条被规则拒绝的操作/);
  assert.match(text, /注意：删除远端项目/);
  const choices = nodesOf(frame.dock ?? []).filter((node) => node.kind === 'choice');
  assert.equal(choices[0]?.kind === 'choice' && choices[0].selected, true);
  assert.equal(choices[0]?.kind === 'choice' && choices[0].hit, 'approval:0');
  const moved = nodesOf(frameOf({ ...asked, approvalCursor: 2 }, { width: WIDTH, now: 1_000 }).dock ?? []).filter((node) => node.kind === 'choice');
  assert.equal(moved[2]?.kind === 'choice' && moved[2].selected, true);
  assert.match(textOf(frameOf(asked, { width: WIDTH, now: 11_001 }).dock ?? []), /你还在吗/);
  assert.match(statusBar(asked, { now: 11_001 }).activity, /你还在吗/);
  assertTextFits(bodyLines(asked), 'approval');
});

test('approval strips control characters and records an answer', () => {
  seq = 0;
  const asked = viewOf([event('approval.requested', { callId: 'c9', name: 'Bash', rule: 'escalation', reason: '看\u001B[31m起来无害', command: 'echo hi', dimensions: ['unsandboxed'] })]);
  const text = textOf(frameOf(asked, { width: WIDTH, now: 0 }).dock ?? []);
  assert.doesNotMatch(text, /\u001B/);
  assert.match(text, /本次脱离沙箱执行/);
  const answered = project(asked, event('approval.answered', { callId: 'c9', key: 'k', verdict: 'reject', by: 'user' }));
  assert.match(textOf(frameOf(answered, { width: WIDTH, now: 0 }).dock ?? []), /行吧，这条不干/);
});

test('thinking is a native disclosure choice and live reasoning stays bounded', () => {
  seq = 0;
  const base = viewOf([event('model.message', { text: '回答', toolCalls: [], reasoning: [{ type: 'thinking', text: '先看 joinPath 的实现', signature: 's' }], stopReason: null })]);
  assert.doesNotMatch(textOf(frameOf(base, { width: WIDTH, now: 0 }).body), /先看 joinPath/);
  assert.match(textOf(frameOf(toggleThinking(base), { width: WIDTH, now: 0 }).body), /先看 joinPath/);
  assert.match(textOf(frameOf({ ...initialView(), reasoningStream: '先看调用点，再改实现。', reasoningShown: 999 }, { width: WIDTH, now: 0 }).body), /思考中/);
});

test('running tools have a stable native card; animation belongs to the cat', () => {
  seq = 0;
  const view = viewOf([event('model.message', { text: '', toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'npm test --watch' } }], reasoning: [], stopReason: null })]);
  assert.deepEqual(askedText(view, 0), askedText(view, 150));
  function askedText(input: TuiView, now: number): string { return textOf(frameOf(input, { width: WIDTH, now }).body); }
  assert.match(askedText(view, 0), /npm test --watch/);
  assert.deepEqual(view.pendingTools, [{ callId: 'c1', name: 'Bash' }]);
});

test('live tool output keeps twenty rows and reports truncation honestly', () => {
  const base: TuiView = { ...initialView(), turn: { id: 't', state: 'awaiting_tools', reason: null, cronSourced: false }, pendingTools: [{ callId: 'c1', name: 'Bash' }], calls: { c1: { name: 'Bash', input: { command: 'pnpm build' } } } };
  const many = Array.from({ length: 30 }, (_, index) => `row${String(index)}`).join('\n');
  const capped = textOf(frameOf({ ...base, toolOutput: { c1: { text: many, truncated: false } } }, { width: WIDTH, now: 0 }).body);
  assert.match(capped, /row29/);
  assert.doesNotMatch(capped, /row0/);
  assert.match(capped, /上面还有 10 行/);
  const truncated = textOf(frameOf({ ...base, toolOutput: { c1: { text: many, truncated: true } } }, { width: WIDTH, now: 0 }).body);
  assert.match(truncated, /只显示末尾输出/);
});

test('long output wraps at the measured inner width without truncating content', () => {
  seq = 0;
  const view = viewOf([event('tool.finished', { callId: 'c1', name: 'Bash', ok: true, output: 'a'.repeat(100), facts: null, truncation: null, attachments: null, path: null })]);
  const rows = rowsOf(frameOf(view, { width: 40, now: 0 }).body);
  assert.ok(rows.some((row) => row.text.includes('a'.repeat(34))));
  assert.equal(rows.some((row) => row.text.includes('…')), false);
});

test('todos and running agents remain structured rail panels', () => {
  seq = 0;
  const view = viewOf([
    event('todo.updated', { todos: [{ content: '加输入校验', status: 'in_progress', activeForm: '在加输入校验' }, { content: '写测试', status: 'pending', activeForm: '在写测试' }, { content: '跑一遍', status: 'completed', activeForm: '在跑' }] }),
    event('subagent.started', { callId: 'c1', childSessionId: 'sess_child', role: 'explore', description: '看 src 目录' }),
  ]);
  const rail = frameOf(view, { width: WIDTH, now: 5_000 }).leftRail;
  assert.deepEqual(rail?.panels[0]?.rows.map((row) => row.text), ['在加输入校验', '写测试', '跑一遍']);
  assert.equal(rail?.panels[0]?.rows[0]?.accent, true);
  assert.equal(rail?.mascotState, 'tools');
  assert.equal(frameOf({ ...view, todosVisible: false }, { width: WIDTH, now: 0 }).leftRail?.panels.some((panel) => panel.title.startsWith('待办')), false);
});

test('palettes window around the selection and preserve absolute hit ids', () => {
  const panel = commandPalette(COMMANDS, 1, WIDTH);
  assert.equal(panel.kind, 'panel');
  const text = textOf([panel]);
  for (const command of COMMANDS.slice(0, 7)) assert.match(text, new RegExp(`/${command.name}`));
  const first = panel.kind === 'panel' ? panel.children[1] : undefined;
  assert.equal(first?.kind === 'choice' && first.selected, true);
  assert.equal(first?.kind === 'choice' && first.hit, 'palette:1');
  const last = COMMANDS.length - 1;
  const tail = commandPalette(COMMANDS, last, WIDTH);
  const choices = nodesOf([tail]).filter((node) => node.kind === 'choice');
  assert.equal(choices.at(-1)?.kind === 'choice' && choices.at(-1)?.hit, `palette:${String(last)}`);
  assert.doesNotMatch(textOf([tail]), /\/todos/);
});

test('status names the activity and exposes facts without a spinner', () => {
  const running: TuiView = {
    ...initialView(), sessionId: 'sess_run', model: 'zai/glm-5.3-flash', turnStartedAt: 0,
    turn: { id: 't', state: 'awaiting_tools', reason: null, cronSourced: false }, pendingTools: [{ callId: 'c1', name: 'Bash' }],
  };
  assert.match(statusBar(running, { now: 0 }).activity, /执行 Bash/);
  assert.equal(statusBar(running, { now: 0 }).token, 'act');
  const facts = statusBar({ ...running, agents: [{ childSessionId: 's', role: 'explore', description: '', state: 'running', turns: 2, startedAt: 0 }] }, { now: 12_000 });
  assert.match(facts.activity, /子 agent 1 个运行中/);
  assert.deepEqual(facts.facts[0], { label: '模型', value: 'glm-5.3-flash' });
  assert.deepEqual(facts.facts[1], { label: '用时', value: '12s' });
  assert.doesNotMatch(facts.activity, /⠋|⠙|⠹|⠸/);
});

test('context usage has an honest denominator and mode chips remain visible', () => {
  const view: TuiView = { ...initialView(), contextWindow: 200_000, usage: { input: 4_000, output: 200, cacheRead: 80_000, cacheCreation: 0 } };
  assert.deepEqual(statusBar(view, { now: 0 }).facts[0], { label: '上下文', value: '42%' });
  assert.equal(statusBar({ ...view, contextWindow: null }, { now: 0 }).facts.some((fact) => fact.label === '上下文'), false);
  assert.equal(statusBar({ ...view, usage: null }, { now: 0 }).facts.some((fact) => fact.label === '上下文'), false);
  assert.deepEqual(statusBar({ ...initialView(), acceptEdits: true }, { now: 0 }).facts[0], { label: '模式', value: '接受编辑' });
  assert.deepEqual(statusBar({ ...initialView(), planMode: true }, { now: 0 }).facts[0], { label: '模式', value: 'plan' });
});

test('task panels window around the selected row and use native selection', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => ({ taskId: `bg_a_${String(index + 1)}`, callId: 'c1', command: `cmd ${String(index + 1)}`, startedAt: 0, startedSeq: index + 2, state: 'running' as const, endedAt: null, exitCode: null }));
  const panel = taskPanel(tasks, 7, 80, 12_000);
  const text = textOf([panel]);
  assert.match(text, /bg_a_8/);
  assert.doesNotMatch(text, /bg_a_1\b/);
  const choices = nodesOf([panel]).filter((node) => node.kind === 'choice');
  assert.equal(choices.at(-1)?.kind === 'choice' && choices.at(-1)?.selected, true);
  assert.match(text, /运行中 12s/);
});

test('hit ids remain on tool, approval, slash and return-to-bottom components', () => {
  seq = 0;
  const tool = toolResult('hello');
  const toolHit = nodesOf(frameOf(tool, { width: WIDTH, now: 0 }).body).find((node) => node.kind === 'block');
  assert.equal(toolHit?.kind === 'block' && toolHit.hit, 'tool:c1');
  const approval = viewOf([event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null })]);
  const approvalHits = nodesOf(frameOf(approval, { width: WIDTH, now: 0 }).dock ?? []).filter((node) => node.kind === 'choice' && node.hit !== undefined);
  assert.equal(approvalHits[0]?.kind === 'choice' && approvalHits[0].hit, 'approval:0');
  const slash = nodesOf(frameOf({ ...initialView(), input: '/' }, { width: WIDTH, now: 0 }).dock ?? []).filter((node) => node.kind === 'choice');
  assert.equal(slash[0]?.kind === 'choice' && slash[0].hit, 'slash:0');
  assert.equal(slash[0]?.kind === 'choice' && slash[0].selected, true);
  assert.deepEqual(slashMatches('/help me'), []);
  const paused = frameOf({ ...initialView(), scrollOffset: 4, newSinceScroll: 3 }, { width: WIDTH, now: 0 }).dock ?? [];
  assert.equal(paused[0]?.kind === 'choice' && paused[0].hit, 'scroll:bottom');
  assert.match(textOf(paused), /3 条新输出/);
  assert.equal(frameOf(initialView(), { width: WIDTH, now: 0 }).dock?.some((node) => node.kind === 'choice' && node.hit === 'scroll:bottom'), false);
  assert.equal(frameOf({ ...approval, scrollOffset: 4 }, { width: WIDTH, now: 0 }).dock?.some((node) => node.kind === 'choice' && node.hit === 'scroll:bottom'), false);
});

test('status reports elapsed time, scrolling, failures and narrow widths', () => {
  const view: TuiView = { ...initialView(), model: 'zai/glm-5.3-flash', turn: { id: 't', state: 'streaming', reason: null, cronSourced: false }, turnStartedAt: 0 };
  assert.deepEqual(statusBar(view, { now: 12_000 }).facts[1], { label: '用时', value: '12s' });
  assert.deepEqual(statusBar({ ...view, scrollOffset: 5, newSinceScroll: 3 }, { now: 12_000 }).facts[2], { label: '新输出', value: '3' });
  seq = 0;
  const failed = statusBar(viewOf([event('turn.transitioned', { from: 'streaming', to: 'failed', reason: 'upstream 503' })]), { now: 0 });
  assert.match(failed.activity, /upstream 503/);
  assert.equal(failed.token, 'alert');
  assert.ok(stringWidth(statusBar({ ...initialView(), closed: true }, { now: 0, width: 20 }).activity) <= 20);
});

test('an answered approval no longer suppresses the slash menu', () => {
  const approval = { callId: 'c1', name: 'Bash', rule: 'no-rule-matched', reason: null, warning: null, command: null, path: null, dimensions: [] as never[], askedAt: 0, verdict: null as string | null, by: null as string | null };
  assert.doesNotMatch(textOf(frameOf({ ...initialView(), approval, input: '/' }, { width: WIDTH, now: 0 }).dock ?? []), /\/todos/);
  assert.match(textOf(frameOf({ ...initialView(), approval: { ...approval, verdict: 'once', by: 'user' }, input: '/' }, { width: WIDTH, now: 0 }).dock ?? []), /\/todos/);
});

test('slash hints and image sizing stay intact', () => {
  assert.match(frameOf({ ...initialView(), input: '/' }, { width: WIDTH, now: 0 }).placeholder, /\/todos/);
  assert.match(frameOf({ ...initialView(), input: '/th' }, { width: WIDTH, now: 0 }).placeholder, /\/thinking/);
  assert.match(frameOf({ ...initialView(), input: '/nope' }, { width: WIDTH, now: 0 }).placeholder, /没有这个命令/);
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: 100, height: 40 }), { cols: 44, rows: 9 });
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: 200, height: 400 }), { cols: 12, rows: 12 });
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: null, height: null }), { cols: 24, rows: 8 });
  assert.deepEqual(imageBox({ cols: 44, maxRows: 12, width: 4, height: 4 }), { cols: 4, rows: 2 });
});
