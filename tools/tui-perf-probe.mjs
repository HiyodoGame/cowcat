// TUI 渲染路径性能探针（开发期脚本，不进 lint 门禁、不进发布包）。
//
// 度量 run.ts 的 draw() 在每次事件/delta/按键上付出的成本：
//   draw() = frameOf(view)（整帧重建）→ screen.update（仅同步可见切片，O(visible)）
// 所以本探针聚焦 frameOf 及其内部的 O(n) 片段，按会话规模与流式长度给出每帧毫秒数。
//
// 用法：node tools/tui-perf-probe.mjs     （纯函数，Node 24 即可，无需 opentui）

import { initialView } from '../packages/tui/dist/src/app/view.js';
import { project, streamText } from '../packages/tui/dist/src/app/project.js';
import { frameOf } from '../packages/tui/dist/src/components/session-frame.js';
import { wrap } from '../packages/tui/dist/src/text/wrap.js';

const W = 100;
const H = 40;
const FRAME_OPTS = { width: W, height: H, now: 1_000_000 };

/** 一轮对话：user 提问 + assistant 长回答（带 thinking 块）+ 两个工具卡。 */
function addRound(view, seq, { userChars = 300, answerChars = 2_500, toolChars = 3_000 } = {}) {
  const entries = [...view.entries];
  entries.push({ kind: 'user', seq: seq + 1, text: 'x'.repeat(userChars) });
  entries.push({
    kind: 'assistant',
    seq: seq + 2,
    text: `回答`.repeat(Math.ceil(answerChars / 2)),
    calls: 2,
    reasoning: ['先看文件。'.repeat(50), '再跑测试。'.repeat(50)],
    redactedThinking: 0,
  });
  for (let i = 0; i < 2; i += 1) {
    entries.push({
      kind: 'tool',
      seq: seq + 3 + i,
      callId: `call_${seq}_${i}`,
      name: i === 0 ? 'Read' : 'Bash',
      ok: true,
      output: '→ '.repeat(Math.ceil(toolChars / 2)),
      truncation: null,
      attachments: [],
      path: null,
    });
  }
  return { ...view, entries, lastSeq: seq + 4 };
}

function viewWithRounds(rounds) {
  let view = initialView();
  for (let i = 0; i < rounds; i += 1) view = addRound(view, i * 4);
  return view;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { mean, p95, max: sorted[sorted.length - 1] };
}

function report(label, samples, extra = '') {
  const s = stats(samples);
  console.log(
    `  ${label.padEnd(46)} mean ${s.mean.toFixed(2).padStart(7)} ms   p95 ${s.p95.toFixed(2).padStart(7)} ms   max ${s.max.toFixed(2).padStart(7)} ms${extra}`,
  );
}

console.log('== 1. frameOf 整帧重建 vs 会话规模（idle，无流式） ==');
for (const rounds of [10, 50, 100, 200]) {
  const view = viewWithRounds(rounds);
  const first = frameOf(view, FRAME_OPTS);
  const samples = [];
  for (let i = 0; i < 30; i += 1) {
    const t0 = performance.now();
    frameOf(view, FRAME_OPTS);
    samples.push(performance.now() - t0);
  }
  report(`frameOf · ${String(rounds).padStart(3)} 轮（${first.body.length} 行）`, samples);
}

console.log('== 2. 流式回答：per-delta（streamText + frameOf，10 轮基座，每 100 个 delta 采样一次） ==');
{
  const base = viewWithRounds(10);
  const DELTA = 10; // 字符/次
  const TOTAL = 20_000; // 一条 2 万字符的长回答
  const deltas = TOTAL / DELTA;
  const samples = [];
  let view = base;
  for (let i = 0; i < deltas; i += 1) {
    view = streamText(view, { type: 'model.delta', text: '字'.repeat(DELTA) });
    if (i % 100 === 0) {
      const t1 = performance.now();
      frameOf(view, FRAME_OPTS);
      samples.push({ at: (i + 1) * DELTA, ms: performance.now() - t1 });
    }
  }
  for (const s of [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]]) {
    console.log(`  streaming=${String(s.at).padStart(6)} 字 → frameOf ${s.ms.toFixed(1)} ms`);
  }
}

console.log('== 3. 流式思考（reasoning）：一个 50ms tick 的全量工作（10 轮基座） ==');
{
  const base = viewWithRounds(10);
  const N = 30_000; // 累计 3 万字符 reasoning
  const view = {
    ...base,
    reasoningStream: '思'.repeat(N),
    reasoningShown: N - 500,
    turn: { state: 'running' },
  };
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    Array.from(view.reasoningStream).length; // advanceReasoning 的第一步
    frameOf(view, FRAME_OPTS); // draw() 的主体
    samples.push(performance.now() - t0);
  }
  report(`tick 全量（Array.from + frameOf）· reasoning ${N} 字`, samples);
  const t0 = performance.now();
  for (let i = 0; i < 30; i += 1) Array.from(view.reasoningStream).length;
  console.log(`  其中仅 Array.from(reasoning).length：${((performance.now() - t0) / 30).toFixed(2)} ms/次`);
  const shown = Array.from(view.reasoningStream).slice(0, view.reasoningShown).join('');
  const t1 = performance.now();
  for (let i = 0; i < 30; i += 1) wrap(shown, W - 4);
  console.log(`  其中仅 wrap(revealed)：${((performance.now() - t1) / 30).toFixed(2)} ms/次（结果只取尾 6 行）`);
}

console.log('== 4. project() 单事件增量（对照，应当便宜） ==');
{
  const view = viewWithRounds(100);
  const samples = [];
  let seq = view.lastSeq;
  for (let i = 0; i < 200; i += 1) {
    const event = { type: 'todo.updated', seq: (seq += 1), todos: [] };
    const t0 = performance.now();
    project(view, event);
    samples.push(performance.now() - t0);
  }
  report('project · todo.updated（100 轮会话）', samples);
}

console.log('== 5. 微基准：帧内重复付出的原子成本 ==');
{
  const { graphemes, stringWidth, truncate } = await import('../packages/tui/dist/src/text/width.js');
  const chars = 10_000;
  const text = '字'.repeat(chars);
  const border = '─'.repeat(96);
  for (const [label, fn] of [
    [`graphemes · ${chars} 字`, () => graphemes(text)],
    [`stringWidth · ${chars} 字`, () => stringWidth(text)],
    [`wrap · ${chars} 字`, () => wrap(text, W)],
    [`truncate · 96 列边框行`, () => truncate(border, 96)],
  ]) {
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) fn();
    console.log(`  ${label.padEnd(30)} ${((performance.now() - t0) / 20).toFixed(2)} ms/次`);
  }
}
