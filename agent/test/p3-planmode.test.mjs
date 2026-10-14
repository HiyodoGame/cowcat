// P3: EnterPlanMode / ExitPlanMode — the plan-then-execute loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Permissions } from '../src/permissions.js';
import { validateRule } from '../src/perrules.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed = (str, tools = ['Read', 'Write', 'Edit', 'Bash']) => validateRule(str, tools).rule;

// --- unit: acceptEdits tier -----------------------------------------------------

test('P3: acceptEdits tier auto-allows Write/Edit, still asks for Bash', () => {
  const perms = new Permissions('acceptEdits');
  assert.equal(perms.mode, 'acceptEdits', 'constructor keeps the new tier');
  assert.equal(perms.decide('Write', { file_path: '/x' }), 'allow');
  assert.equal(perms.decide('Edit', { file_path: '/x' }), 'allow');
  assert.equal(perms.decide('Bash', { command: 'npm install' }), 'ask', 'Bash still asks');
  assert.equal(perms.check('Write', { file_path: '/x' }), true);
  assert.equal(perms.check('Bash', { command: 'npm install' }), false);
  // config rules keep priority over the tier
  perms.setRules({ deny: [parsed('Write')], allow: [], ask: [] });
  assert.equal(perms.decide('Write', { file_path: '/x' }), 'deny', 'deny rules still win');
  perms.setRules({ allow: [parsed('Bash(npm run test:*)')], deny: [], ask: [] });
  assert.equal(perms.decide('Bash', { command: 'npm run test:unit' }), 'allow', 'allow rules still apply');
  // unknown modes still normalize to default; setMode accepts the tier
  perms.setMode('bogus');
  assert.equal(perms.mode, 'default');
  perms.setMode('acceptEdits');
  assert.equal(perms.mode, 'acceptEdits');
  // plan meta tools pass the plan-mode gate so they run while planning
  const planPerms = new Permissions('plan');
  assert.equal(planPerms.planReject('EnterPlanMode', {}), null);
  assert.equal(planPerms.planReject('ExitPlanMode', {}), null);
});

// --- e2e: scripted CLI against a fake anthropic endpoint --------------------------

function fakeLLMServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function sseEvents(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}

const sseText = (res, text) => sseEvents(res, [
  { type: 'message_start', message: { usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
]);

const sseToolUse = (res, name, input) => sseEvents(res, [
  { type: 'message_start', message: { usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
]);

// Each entry: a responder (req, res) => bool for /v1/messages calls, in order.
function scriptedServer(responders, bodies) {
  return fakeLLMServer((req, res, body) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
    bodies.push(JSON.parse(body || '{}'));
    const fn = responders[Math.min(bodies.length - 1, responders.length - 1)];
    fn(req, res);
  });
}

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-p3-'));
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ trustedProjects: [cwd] }));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), ...args], {
      env: { ...process.env, COWCAT_HOME: cwd, ...env },
      cwd,
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, cwd }); });
  });
}

const LLM_ENV = (port) => ({
  COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
  COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
});

const bodyHas = (bodies, i, needle) => JSON.stringify(bodies[i] ?? {}).includes(needle);

test('P3 e2e: EnterPlanMode switches to plan mode and writes are rejected', async () => {
  const bodies = [];
  const { server, port } = await scriptedServer([
    (_req, res) => { sseToolUse(res, 'EnterPlanMode', {}); return true; },
    (_req, res) => { sseToolUse(res, 'Write', { file_path: 'probe.txt', content: 'x' }); return true; },
    (_req, res) => { sseText(res, 'explored, plan ready'); return true; },
  ], bodies);
  try {
    const res = await runCli([], LLM_ENV(port), 'add a file\n/exit\n');
    assert.equal(res.code, 0, res.err);
    assert.ok(bodyHas(bodies, 1, 'plan mode'), 'EnterPlanMode result feeds back to the model');
    assert.ok(bodyHas(bodies, 2, 'Denied in plan mode'), 'Write rejected while planning');
    assert.ok(!existsSync(join(res.cwd, 'probe.txt')), 'no file written in plan mode');
  } finally {
    server.close();
  }
});

test('P3 e2e: EnterPlanMode in plan mode reports it is already planning', async () => {
  const bodies = [];
  const { server, port } = await scriptedServer([
    (_req, res) => { sseToolUse(res, 'EnterPlanMode', {}); return true; },
    (_req, res) => { sseText(res, 'ok'); return true; },
  ], bodies);
  try {
    const res = await runCli([], LLM_ENV(port), '/plan\nadd a file\n/exit\n');
    assert.equal(res.code, 0, res.err);
    assert.ok(bodyHas(bodies, 1, 'lready in plan mode'), 'second EnterPlanMode is a no-op notice');
  } finally {
    server.close();
  }
});

test('P3 e2e: ExitPlanMode outside plan mode is an error', async () => {
  const bodies = [];
  const { server, port } = await scriptedServer([
    (_req, res) => { sseToolUse(res, 'ExitPlanMode', { plan: '# Plan' }); return true; },
    (_req, res) => { sseText(res, 'my bad'); return true; },
  ], bodies);
  try {
    const res = await runCli([], LLM_ENV(port), 'hi\n/exit\n');
    assert.equal(res.code, 0, res.err);
    assert.ok(bodyHas(bodies, 1, 'only available in plan mode'), 'rejected outside plan mode');
  } finally {
    server.close();
  }
});

test('P3 e2e: ExitPlanMode approved -> acceptEdits tier, Write runs without approval', async () => {
  const bodies = [];
  const { server, port } = await scriptedServer([
    (_req, res) => { sseToolUse(res, 'EnterPlanMode', {}); return true; },
    (_req, res) => { sseToolUse(res, 'ExitPlanMode', { plan: '# Plan\n1. write probe.txt', allowedPrompts: [{ tool: 'Bash', prompt: 'npm run test' }] }); return true; },
    (_req, res) => { sseToolUse(res, 'Write', { file_path: 'probe.txt', content: 'hello plan' }); return true; },
    (_req, res) => { sseText(res, 'done'); return true; },
  ], bodies);
  try {
    // stdin: prompt, then ONE approval line for ExitPlanMode; the Write must
    // not consume any input — if it asked, /exit would be eaten as the answer.
    const res = await runCli([], LLM_ENV(port), 'implement it\ny\n/exit\n');
    assert.equal(res.code, 0, res.err);
    assert.ok(bodyHas(bodies, 2, 'Plan approved'), 'approval result feeds back to the model');
    const file = join(res.cwd, 'probe.txt');
    assert.ok(existsSync(file), 'Write executed without a second approval');
    assert.equal(readFileSync(file, 'utf8'), 'hello plan');
    assert.ok(!bodyHas(bodies, 3, 'User denied'), 'Write was not denied');
  } finally {
    server.close();
  }
});

test('P3 e2e: ExitPlanMode rejected -> stays in plan mode, Write still blocked', async () => {
  const bodies = [];
  const { server, port } = await scriptedServer([
    (_req, res) => { sseToolUse(res, 'EnterPlanMode', {}); return true; },
    (_req, res) => { sseToolUse(res, 'ExitPlanMode', { plan: '# Plan\n1. write probe.txt' }); return true; },
    (_req, res) => { sseToolUse(res, 'Write', { file_path: 'probe.txt', content: 'x' }); return true; },
    (_req, res) => { sseText(res, 'revising'); return true; },
  ], bodies);
  try {
    const res = await runCli([], LLM_ENV(port), 'implement it\nn\n/exit\n');
    assert.equal(res.code, 0, res.err);
    assert.ok(bodyHas(bodies, 2, 'rejected this plan'), 'rejection result feeds back to the model');
    assert.ok(bodyHas(bodies, 3, 'Denied in plan mode'), 'still in plan mode after rejection');
    assert.ok(!existsSync(join(res.cwd, 'probe.txt')), 'no file written after rejection');
  } finally {
    server.close();
  }
});
