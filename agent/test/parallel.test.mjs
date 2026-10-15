// P5: parallel tool execution within a turn. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { GlobTool } from '../src/tools/glob.js';
import { GrepTool } from '../src/tools/grep.js';
import { BashTool } from '../src/tools/bash.js';
import { TodoWriteTool } from '../src/tools/todo.js';
import { AskUserQuestionTool } from '../src/tools/ask.js';
import { AgentTool } from '../src/tools/agent.js';
import { Permissions } from '../src/permissions.js';
import { MockUI } from '../src/ui.js';
import { runLoop } from '../src/loop.js';
import { MockProvider, text } from './mock-provider.js';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeRegistry(overrides = {}) {
  const reg = new ToolRegistry();
  for (const t of [ReadTool, EditTool, WriteTool, GlobTool, GrepTool, BashTool, TodoWriteTool, AskUserQuestionTool, AgentTool]) {
    reg.register(overrides[t.name] || t);
  }
  return reg;
}

function makeCtx(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-par-'));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home; // session/todo/audit persistence targets the cowcat home dir
  return {
    cwd, home, readSet: new Set(), state: {}, sessionId: 'par-test',
    ui: new MockUI(), permissions: new Permissions('yolo'),
    config: { maxTokens: 1024, maxContextTokens: 100000 },
    ...over,
  };
}

const SYS = 'You are a test agent.';
const NL = String.fromCharCode(10);

async function run(script, { messages, ctx, permissions, ui, providerOpts, registry } = {}) {
  const provider = new MockProvider(script, providerOpts);
  const reg = registry || makeRegistry();
  const finalCtx = ctx || makeCtx();
  finalCtx.permissions = permissions || finalCtx.permissions;
  finalCtx.ui = ui || finalCtx.ui;
  const res = await runLoop({
    provider, registry: reg, system: SYS, messages: messages || [], ctx: finalCtx,
    ui: finalCtx.ui, permissions: finalCtx.permissions, config: finalCtx.config,
  });
  return { ...res, provider, ctx: finalCtx };
}

// Bash wrapper that tracks the peak number of concurrently executing calls.
function concurrencyTrackingRegistry() {
  const tracker = { active: 0, max: 0 };
  const wrapped = {
    ...BashTool,
    execute: async (input, ctx) => {
      tracker.active++;
      tracker.max = Math.max(tracker.max, tracker.active);
      try {
        return await BashTool.execute(input, ctx);
      } finally {
        tracker.active--;
      }
    },
  };
  return { registry: makeRegistry({ Bash: wrapped }), tracker };
}

test('a) two Bash calls in one turn run concurrently (file barrier proves overlap)', async () => {
  const ctx = makeCtx();
  const log = join(ctx.cwd, 'barrier.log');
  // a.js waits (up to 3s) for B to start before it ends; sequential execution
  // would make A-end always precede B-start.
  writeFileSync(join(ctx.cwd, 'a.js'), `
const fs = require('node:fs');
const NL = String.fromCharCode(10);
fs.appendFileSync(${JSON.stringify(log)}, 'A-start' + NL);
const t0 = Date.now();
const iv = setInterval(() => {
  let s = '';
  try { s = fs.readFileSync(${JSON.stringify(log)}, 'utf8'); } catch {}
  if (s.includes('B-start') || Date.now() - t0 > 3000) {
    clearInterval(iv);
    fs.appendFileSync(${JSON.stringify(log)}, 'A-end' + NL);
  }
}, 25);
`);
  writeFileSync(join(ctx.cwd, 'b.js'), `
const fs = require('node:fs');
const NL = String.fromCharCode(10);
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(log)}, 'B-start' + NL + 'B-end' + NL);
}, 100);
`);

  const res = await run([
    {
      message: {
        content: [
          { type: 'tool_use', id: 'ba_1', name: 'Bash', input: { command: 'node a.js', timeout: 30000 } },
          { type: 'tool_use', id: 'ba_2', name: 'Bash', input: { command: 'node b.js', timeout: 30000 } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('both ran'),
  ], { messages: [{ role: 'user', content: 'run both' }], ctx });

  const lines = readFileSync(log, 'utf8').split(NL).filter(Boolean);
  const idx = (s) => lines.indexOf(s);
  assert.ok(idx('A-start') >= 0 && idx('B-start') >= 0 && idx('A-end') >= 0, `log complete: ${lines}`);
  assert.ok(idx('A-start') < idx('B-start'), 'B must start while A is still running');
  assert.ok(idx('B-start') < idx('A-end'), 'A must still be waiting when B starts (overlap)');
  assert.equal(res.messages[2].content.length, 2, 'one tool_result per tool_use');
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});

test('b) tool_result array order matches tool_use order even when the second call finishes first', async () => {
  const ctx = makeCtx();
  const log = join(ctx.cwd, 'order.log');
  writeFileSync(join(ctx.cwd, 'slow.js'), `
setTimeout(() => { require('node:fs').appendFileSync(${JSON.stringify(log)}, 'slow-end ' + Date.now() + ${JSON.stringify(NL)}); console.log('SLOW-DONE'); }, 400);
`);
  writeFileSync(join(ctx.cwd, 'fast.js'), `
require('node:fs').appendFileSync(${JSON.stringify(log)}, 'fast-end ' + Date.now() + ${JSON.stringify(NL)}); console.log('FAST-DONE');
`);
  const res = await run([
    {
      message: {
        content: [
          { type: 'tool_use', id: 'slow_1', name: 'Bash', input: { command: 'node slow.js', timeout: 30000 } },
          { type: 'tool_use', id: 'fast_2', name: 'Bash', input: { command: 'node fast.js', timeout: 30000 } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('done'),
  ], { messages: [{ role: 'user', content: 'go' }], ctx });

  const results = res.messages[2].content;
  assert.equal(results[0].tool_use_id, 'slow_1', 'first result pairs with first tool_use');
  assert.match(results[0].content, /SLOW-DONE/);
  assert.equal(results[1].tool_use_id, 'fast_2', 'second result pairs with second tool_use');
  assert.match(results[1].content, /FAST-DONE/);
  // and the fast call really did finish first — so the order was preserved, not accidental
  const stamps = readFileSync(log, 'utf8').split(NL).filter(Boolean)
    .map((l) => l.split(' '))
    .map(([name, t]) => [name, Number(t)]);
  const slowEnd = stamps.find(([n]) => n === 'slow-end')[1];
  const fastEnd = stamps.find(([n]) => n === 'fast-end')[1];
  assert.ok(fastEnd < slowEnd, 'fast call finished first — ordering was genuinely enforced');
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});

test('c) approval-requiring tools are asked sequentially, in original order', async () => {
  const ctx = makeCtx();
  const approveLog = [];
  class TimingUI extends MockUI {
    async approve(toolName, summary, opts) {
      approveLog.push({ event: 'start', toolName, t: Date.now() });
      await new Promise((r) => setTimeout(r, 80)); // visible dialog lifetime
      const ans = await super.approve(toolName, summary, opts);
      approveLog.push({ event: 'end', toolName, t: Date.now() });
      return ans;
    }
  }
  const ui = new TimingUI({ answers: ['y', 'y'] });
  const f1 = join(ctx.cwd, 'one.txt');
  const f2 = join(ctx.cwd, 'two.txt');
  const res = await run([
    {
      message: {
        content: [
          { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: f1, content: '1' } },
          { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: f2, content: '2' } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('written'),
  ], { messages: [{ role: 'user', content: 'write two files' }], ctx, ui, permissions: new Permissions('default') });

  assert.equal(ui.approvals.length, 2);
  assert.deepEqual(ui.approvals.map((a) => a.toolName), ['Write', 'Write']);
  const starts = approveLog.filter((e) => e.event === 'start');
  assert.ok(starts[1].t - starts[0].t >= 70, `approvals must not overlap (delta ${starts[1].t - starts[0].t}ms)`);
  const results = res.messages[2].content;
  assert.equal(results[0].tool_use_id, 'w1');
  assert.equal(results[1].tool_use_id, 'w2');
  assert.ok(existsSync(f1) && existsSync(f2));
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});

test('d) concurrency cap respected: maxParallelTools=2 with 6 calls, default cap 4 with 5 calls', async () => {
  const slowSrc = (ms) => `setTimeout(() => console.log('ok'), ${ms});\n`;

  // cap 2
  {
    const ctx = makeCtx({ config: { maxTokens: 1024, maxContextTokens: 100000, maxParallelTools: 2 } });
    writeFileSync(join(ctx.cwd, 'slow.js'), slowSrc(200));
    const { registry, tracker } = concurrencyTrackingRegistry();
    const script = [
      {
        message: {
          content: Array.from({ length: 6 }, (_, i) => ({
            type: 'tool_use', id: `s${i}`, name: 'Bash', input: { command: 'node slow.js', timeout: 30000 },
          })),
          stopReason: 'tool_use',
        },
      },
      text('six done'),
    ];
    const res = await run(script, { messages: [{ role: 'user', content: 'six slow commands' }], ctx, registry });
    assert.equal(res.messages[2].content.length, 6);
    assert.equal(tracker.max, 2, `cap 2 must never be exceeded (peak ${tracker.max})`);
    rmSync(ctx.cwd, { recursive: true, force: true });
    rmSync(ctx.home, { recursive: true, force: true });
  }

  // default cap 4
  {
    const ctx = makeCtx();
    writeFileSync(join(ctx.cwd, 'slow.js'), slowSrc(200));
    const { registry, tracker } = concurrencyTrackingRegistry();
    const script = [
      {
        message: {
          content: Array.from({ length: 5 }, (_, i) => ({
            type: 'tool_use', id: `s${i}`, name: 'Bash', input: { command: 'node slow.js', timeout: 30000 },
          })),
          stopReason: 'tool_use',
        },
      },
      text('five done'),
    ];
    await run(script, { messages: [{ role: 'user', content: 'five slow commands' }], ctx, registry });
    assert.equal(tracker.max, 4, `default cap 4 should be reached with 5 slow calls (peak ${tracker.max})`);
    rmSync(ctx.cwd, { recursive: true, force: true });
    rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('e) mixed turn: non-interactive calls run in parallel while approval calls run after, all results in tool_use order', async () => {
  const ctx = makeCtx();
  const ui = new MockUI({ answers: ['y'] });
  const pkgPath = join(AGENT_ROOT, 'package.json');
  const out = join(ctx.cwd, 'out.txt');
  const res = await run([
    { message: { content: [
      { type: 'tool_use', id: 'nope', name: 'Flarble', input: {} },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: pkgPath } },
      { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: out, content: 'x' } },
    ], stopReason: 'tool_use' } },
    text('mixed done'),
  ], { messages: [{ role: 'user', content: 'mixed' }], ctx, ui, permissions: new Permissions('default') });

  const results = res.messages[2].content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['nope', 'r1', 'w1'], 'results stay in tool_use order across the partitions');
  assert.match(results[0].content, /Unknown tool/);
  assert.ok(!results[1].is_error);
  assert.ok(!results[2].is_error);
  assert.equal(ui.approvals.length, 1, 'only the Write asks');
  assert.ok(existsSync(out));
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});

test('f) "always" approval still upgrades a later same-key call in the same turn', async () => {
  const ctx = makeCtx();
  const ui = new MockUI({ answers: ['always'] });
  const file = join(ctx.cwd, 'same.txt');
  const res = await run([
    {
      message: {
        content: [
          { type: 'tool_use', id: 'a1', name: 'Write', input: { file_path: file, content: '1' } },
          { type: 'tool_use', id: 'a2', name: 'Write', input: { file_path: file, content: '2' } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('done'),
  ], { messages: [{ role: 'user', content: 'twice' }], ctx, ui, permissions: new Permissions('default') });
  assert.equal(ui.approvals.length, 1, 'second Write must be auto-approved by the first "always"');
  assert.equal(readFileSync(file, 'utf8'), '2');
  const results = res.messages[2].content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['a1', 'a2']);
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});
