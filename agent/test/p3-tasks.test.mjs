// P3: structured task tools (TaskCreate/TaskGet/TaskUpdate/TaskList) + Bash
// background timeout tiering (default 1800s, cap 7200s; foreground unchanged).
// In-process runLoop + MockProvider, own registry — independent of whether the
// CLI entrypoint has wired the new tools into buildRegistry yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import { BashTool, resolveTimeout, BACKGROUND_DEFAULT_TIMEOUT, BACKGROUND_MAX_TIMEOUT, DEFAULT_TIMEOUT, MAX_TIMEOUT } from '../src/tools/bash.js';
import { TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool } from '../src/tools/tasktools.js';
import { Permissions } from '../src/permissions.js';
import { MockUI } from '../src/ui.js';
import { runLoop } from '../src/loop.js';
import { MockProvider, text, toolUse } from './mock-provider.js';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeRegistry() {
  const reg = new ToolRegistry();
  for (const t of [BashTool, TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]) reg.register(t);
  return reg;
}

function makeCtx(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-p3-'));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    cwd, home, readSet: new Set(), state: {}, sessionId: 'test-session-p3',
    ui: new MockUI(), permissions: new Permissions('yolo'),
    config: { maxTokens: 1024, maxContextTokens: 100000 },
    ...over,
  };
}

async function run(script, { messages, ctx } = {}) {
  const provider = new MockProvider(script);
  const registry = makeRegistry();
  const finalCtx = ctx || makeCtx();
  const res = await runLoop({
    provider, registry, system: 'You are a test agent.', messages: messages || [], ctx: finalCtx,
    ui: finalCtx.ui, permissions: finalCtx.permissions, config: finalCtx.config,
  });
  return { ...res, provider, ctx: finalCtx };
}

const SYS_MSGS = (s) => [{ role: 'user', content: s }];

// --- resolveTimeout unit tests -------------------------------------------------

test('P3: foreground timeout tier unchanged (default 60s, cap 600s)', () => {
  assert.equal(resolveTimeout(undefined), DEFAULT_TIMEOUT);
  assert.equal(resolveTimeout(undefined, { background: false }), 60_000);
  assert.equal(resolveTimeout(500), 1000, 'floor 1s');
  assert.equal(resolveTimeout(999_999_999), MAX_TIMEOUT, 'foreground capped at 600s');
  assert.equal(resolveTimeout(120_000), 120_000);
});

test('P3: background timeout tier (default 1800s, cap 7200s)', () => {
  assert.equal(resolveTimeout(undefined, { background: true }), BACKGROUND_DEFAULT_TIMEOUT);
  assert.equal(BACKGROUND_DEFAULT_TIMEOUT, 1_800_000);
  assert.equal(BACKGROUND_MAX_TIMEOUT, 7_200_000);
  assert.equal(resolveTimeout(500, { background: true }), 1000, 'floor 1s');
  assert.equal(resolveTimeout(999_999_999, { background: true }), BACKGROUND_MAX_TIMEOUT, 'background capped at 7200s');
  assert.equal(resolveTimeout(3_600_000, { background: true }), 3_600_000, 'explicit 1h passes through');
});

test('P3: Bash run_in_background passes the tiered timeout to the registry', () => {
  const captured = [];
  const fakeBackground = {
    start: (command, opts) => { captured.push(opts); return { id: 'task_x' }; },
  };
  const ctx = makeCtx({ background: fakeBackground });

  BashTool.execute({ command: 'true', run_in_background: true }, ctx);
  assert.equal(captured[0].timeout, 1_800_000, 'background default is 1800s');

  BashTool.execute({ command: 'true', run_in_background: true, timeout: 7_200_000 }, ctx);
  assert.equal(captured[1].timeout, 7_200_000, 'explicit 7200s accepted');

  BashTool.execute({ command: 'true', run_in_background: true, timeout: 9_999_999 }, ctx);
  assert.equal(captured[2].timeout, 7_200_000, 'above cap clamped to 7200s');
});

// --- structured task tools through the loop ------------------------------------

test('P3: TaskCreate returns a taskId and keeps multiple tasks', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'TaskCreate', { subject: 'Fix auth bug', description: 'Login flow 500s', activeForm: 'Fixing auth bug' }),
    toolUse('tu_2', 'TaskCreate', { subject: 'Add tests' }),
    text('created'),
  ], { messages: SYS_MSGS('track this work') });

  const r1 = JSON.parse(messages[2].content[0].content);
  assert.equal(messages[2].content[0].is_error, undefined);
  assert.equal(r1.taskId, '1');
  assert.equal(r1.task.status, 'pending');
  assert.equal(r1.task.subject, 'Fix auth bug');

  const r2 = JSON.parse(messages[4].content[0].content);
  assert.equal(r2.taskId, '2', 'ids increment, both tasks coexist');
  assert.equal(messages.length, 6);
});

test('P3: TaskCreate without subject is rejected by schema validation', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'TaskCreate', { description: 'no subject' }),
    text('done'),
  ], { messages: SYS_MSGS('go') });
  assert.equal(messages[2].content[0].is_error, true);
  assert.match(messages[2].content[0].content, /subject/);
});

test('P3: TaskUpdate changes status and fields; TaskGet returns full detail', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'TaskCreate', { subject: 'Run tests', activeForm: 'Running tests' }),
    toolUse('tu_2', 'TaskUpdate', { taskId: '1', status: 'in_progress', owner: 'agent-a' }),
    toolUse('tu_3', 'TaskGet', { taskId: '1' }),
    text('updated'),
  ], { messages: SYS_MSGS('do it') });

  const upd = JSON.parse(messages[4].content[0].content);
  assert.equal(upd.task.status, 'in_progress');
  assert.equal(upd.task.owner, 'agent-a');

  const got = JSON.parse(messages[6].content[0].content);
  assert.equal(got.id, '1');
  assert.equal(got.status, 'in_progress');
  assert.equal(got.subject, 'Run tests');
  assert.ok(Array.isArray(got.blocks) && Array.isArray(got.blockedBy));
});

test('P3: TaskUpdate on unknown task and bad status error out', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'TaskUpdate', { taskId: '99', status: 'completed' }),
    toolUse('tu_2', 'TaskCreate', { subject: 'A' }),
    toolUse('tu_3', 'TaskUpdate', { taskId: '1', status: 'bogus' }),
    text('done'),
  ], { messages: SYS_MSGS('go') });

  assert.equal(messages[2].content[0].is_error, true);
  assert.match(messages[2].content[0].content, /Unknown task: 99/);
  assert.equal(messages[6].content[0].is_error, true);
  assert.match(messages[6].content[0].content, /must be one of/, 'schema enum rejects bogus status');
});

test('P3: TaskUpdate deleted removes the task; dependencies mirror both ways', async () => {
  const { ctx, messages } = await run([
    toolUse('tu_1', 'TaskCreate', { subject: 'Setup' }),
    toolUse('tu_2', 'TaskCreate', { subject: 'Build' }),
    toolUse('tu_3', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }),
    toolUse('tu_3b', 'TaskGet', { taskId: '1' }),
    toolUse('tu_4', 'TaskUpdate', { taskId: '1', status: 'deleted' }),
    toolUse('tu_5', 'TaskList', {}),
    text('done'),
  ], { messages: SYS_MSGS('go') });

  const dep = JSON.parse(messages[6].content[0].content);
  assert.deepEqual(dep.task.blockedBy, ['1']);
  const t1 = JSON.parse(messages[8].content[0].content);
  assert.deepEqual(t1.blocks, ['2'], 'mirror link on the blocking task');

  assert.match(messages[10].content[0].content, /deleted/);
  assert.equal(ctx.state.tasks.length, 1, 'only task 2 remains');

  const list = JSON.parse(messages[12].content[0].content);
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].id, '2');
});

test('P3: TaskList filters by status', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'TaskCreate', { subject: 'One' }),
    toolUse('tu_2', 'TaskCreate', { subject: 'Two' }),
    toolUse('tu_3', 'TaskCreate', { subject: 'Three' }),
    toolUse('tu_4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
    toolUse('tu_5', 'TaskList', {}),
    toolUse('tu_6', 'TaskList', { status: 'pending' }),
    toolUse('tu_7', 'TaskList', { status: 'completed' }),
    text('done'),
  ], { messages: SYS_MSGS('go') });

  const all = JSON.parse(messages[10].content[0].content);
  assert.equal(all.tasks.length, 3);
  const pending = JSON.parse(messages[12].content[0].content);
  assert.deepEqual(pending.tasks.map((t) => t.id), ['1', '3']);
  const completed = JSON.parse(messages[14].content[0].content);
  assert.deepEqual(completed.tasks.map((t) => t.id), ['2']);
});

test('P3: task state survives across separate runLoop invocations on one ctx', async () => {
  const ctx = makeCtx();
  await run([
    toolUse('tu_1', 'TaskCreate', { subject: 'Persist me' }),
    text('ok'),
  ], { messages: SYS_MSGS('first'), ctx });

  const { messages } = await run([
    toolUse('tu_2', 'TaskList', {}),
    text('ok'),
  ], { messages: [{ role: 'user', content: 'second turn' }], ctx });

  const list = JSON.parse(messages[2].content[0].content);
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].subject, 'Persist me');
});

test('P3: metadata merge via TaskUpdate (null deletes a key)', async () => {
  const { ctx } = await run([
    toolUse('tu_1', 'TaskCreate', { subject: 'Meta' }),
    toolUse('tu_2', 'TaskUpdate', { taskId: '1', metadata: { priority: 'high', area: 'auth' } }),
    toolUse('tu_3', 'TaskUpdate', { taskId: '1', metadata: { priority: null, area: 'auth' } }),
    text('ok'),
  ], { messages: SYS_MSGS('go') });

  assert.deepEqual(ctx.state.tasks[0].metadata, { area: 'auth' });
});

test('P3: AGENT_ROOT sanity (keeps import used across refactors)', () => {
  assert.ok(AGENT_ROOT.endsWith('agent'));
});
