// P3: Agent tool effort + run_in_background; Read tool allow_large.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentTool } from '../src/tools/agent.js';
import { ReadTool } from '../src/tools/read.js';
import { TaskOutputTool } from '../src/tools/taskoutput.js';
import { BackgroundRegistry } from '../src/background.js';
import { createSubagentRunner } from '../src/subagent.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { MockProvider, text } from './mock-provider.js';
import { MockUI } from '../src/ui.js';
import { buildAnthropicRequestBody, thinkingForEffort } from '../src/llm/anthropic.js';
import { OpenAIProvider } from '../src/llm/openai.js';

function makeRunner(script = [text('sub report')]) {
  const subProvider = new MockProvider(script);
  const runner = createSubagentRunner({
    provider: subProvider,
    registry: new ToolRegistry(),
    config: { maxTokens: 1024, maxContextTokens: 10000 },
    ui: new MockUI(),
    cwd: tmpdir(),
  });
  return { subProvider, runner };
}

// --- Agent: effort --------------------------------------------------------------

test('P3: effort is passed through to the sub agent LLM calls (low/medium/max)', async () => {
  for (const effort of ['low', 'medium', 'max']) {
    const { subProvider, runner } = makeRunner();
    const res = await AgentTool.execute({ description: 'd', prompt: 'p', effort }, { spawnAgent: runner });
    assert.equal(res.ok, true);
    assert.match(res.output, /sub report/);
    assert.equal(subProvider.requests[0].effort, effort, `effort ${effort} reaches provider.chat`);
  }
});

test('P3: default effort (high) does not alter the wire request', async () => {
  const { subProvider, runner } = makeRunner();
  await AgentTool.execute({ description: 'd', prompt: 'p' }, { spawnAgent: runner });
  assert.equal(subProvider.requests[0].effort, undefined, 'high = provider default, no explicit budget');
});

test('P3: effort thinking budgets on the Anthropic body, clamped below max_tokens', () => {
  assert.equal(thinkingForEffort('low', 4096), undefined, 'low disables thinking');
  assert.equal(thinkingForEffort('nonsense', 4096), undefined);
  assert.deepEqual(thinkingForEffort('medium', 4096), { type: 'enabled', budget_tokens: 1024 });
  assert.deepEqual(thinkingForEffort('max', 4096), { type: 'enabled', budget_tokens: 3584 }, 'clamped to max_tokens - 512');
  const body = buildAnthropicRequestBody({ model: 'm', cache: false }, { messages: [], effort: 'xhigh', maxTokens: 20000 });
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 10000 });
  const noEffort = buildAnthropicRequestBody({ model: 'm', cache: false }, { messages: [] });
  assert.equal('thinking' in noEffort, false);
});

test('P3: OpenAI-compatible provider maps effort to reasoning_effort', async () => {
  const saved = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    };
  };
  try {
    const provider = new OpenAIProvider({ baseURL: 'https://x.test', model: 'm', apiKey: 'k', maxTokens: 100 });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: false, effort: 'xhigh' });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: false, effort: 'low' });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(bodies[0].reasoning_effort, 'high', 'xhigh collapses onto high');
    assert.equal(bodies[1].reasoning_effort, 'low');
    assert.equal('reasoning_effort' in bodies[2], false);
  } finally {
    globalThis.fetch = saved;
  }
});

test('P3: Agent schema rejects invalid effort values', () => {
  const reg = new ToolRegistry();
  reg.register(AgentTool);
  assert.equal(reg.validate('Agent', { description: 'd', prompt: 'p', effort: 'ultra' }).ok, false);
  assert.ok(reg.validate('Agent', { description: 'd', prompt: 'p', effort: 'max', run_in_background: true }).ok);
});

// --- Agent: run_in_background ------------------------------------------------------

test('P3: run_in_background returns a task id; TaskOutput retrieves the report', async () => {
  const reg = new BackgroundRegistry();
  const { runner } = makeRunner([text('bg report body')]);
  const ctx = { spawnAgent: runner, background: reg };
  const started = await AgentTool.execute({ description: 'bg task', prompt: 'p', run_in_background: true }, ctx);
  assert.equal(started.ok, true);
  const taskId = started.output.match(/task_[\w]+/)[0];
  assert.match(started.output, /TaskOutput/);

  const blocked = await TaskOutputTool.execute({ task_id: taskId, block: true, timeout: 30_000 }, ctx);
  assert.equal(blocked.ok, true);
  assert.match(blocked.output, /bg report body/);
  assert.match(blocked.output, /"running": false/);
  assert.match(blocked.output, /"exitCode": 0/);
  reg.killAll();
});

test('P3: background sub agent failure surfaces via TaskOutput stderr + exitCode 1', async () => {
  const reg = new BackgroundRegistry();
  const ctx = {
    background: reg,
    spawnAgent: async () => { throw new Error('sub exploded'); },
  };
  const started = await AgentTool.execute({ description: 'boom', prompt: 'p', run_in_background: true }, ctx);
  assert.equal(started.ok, true);
  const taskId = started.output.match(/task_[\w]+/)[0];
  const blocked = await TaskOutputTool.execute({ task_id: taskId, block: true, timeout: 30_000 }, ctx);
  assert.match(blocked.output, /sub exploded/);
  assert.match(blocked.output, /"exitCode": 1/);
  reg.killAll();
});

test('P3: run_in_background without background infra errors clearly (no silent fallback)', async () => {
  const res = await AgentTool.execute(
    { description: 'd', prompt: 'p', run_in_background: true },
    { spawnAgent: async () => 'x' },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /Background execution is not available/);
});

// --- Read: allow_large --------------------------------------------------------------

function bigFile(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-read-'));
  const file = join(dir, 'big.txt');
  writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

test('P3: allow_large reads 5-20MB files whole; default still refuses', () => {
  const file = bigFile(6 * 1024 * 1024);
  const ctx = { cwd: tmpdir(), readSet: new Set() };
  const refused = ReadTool.execute({ file_path: file }, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /5MB/);

  const allowed = ReadTool.execute({ file_path: file, allow_large: true }, ctx);
  assert.equal(allowed.ok, true);
  assert.ok(!allowed.output.includes('[showing lines'), 'no paging marker when reading whole');
  assert.ok(allowed.output.startsWith('1\tx'));
  assert.ok(allowed.output.length > 6 * 1024 * 1024, 'full content returned');
  assert.ok(allowed.output.endsWith('x'));
  assert.ok(ctx.readSet.has(file), 'file registered as read');
});

test('P3: files above the 20MB hard limit are refused even with allow_large', () => {
  const file = bigFile(21 * 1024 * 1024);
  const res = ReadTool.execute({ file_path: file, allow_large: true }, { cwd: tmpdir(), readSet: new Set() });
  assert.equal(res.ok, false);
  assert.match(res.error, /20MB/);
});

test('P3: Read schema accepts allow_large; small files behave exactly as before', () => {
  const reg = new ToolRegistry();
  reg.register(ReadTool);
  assert.ok(reg.validate('Read', { file_path: '/a', allow_large: true }).ok);

  const dir = mkdtempSync(join(tmpdir(), 'cowcat-read-'));
  const small = join(dir, 'small.txt');
  writeFileSync(small, Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join('\n'));
  const ctx = { cwd: tmpdir(), readSet: new Set() };
  const paged = ReadTool.execute({ file_path: small }, ctx);
  assert.equal(paged.ok, true);
  assert.match(paged.output, /\[showing lines 1-2000 of 2500\]/, 'default paging unchanged');
  const whole = ReadTool.execute({ file_path: small, allow_large: true }, ctx);
  assert.equal(whole.output.includes('[showing lines'), false);
  assert.match(whole.output, /2500\tline2500/);
});
