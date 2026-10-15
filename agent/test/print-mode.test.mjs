// -p (print / non-interactive) mode: approvals auto-deny without touching
// stdin, the final answer prints exactly once, and permission-blocked runs
// exit non-zero. Includes a spawn-level regression against a fake SSE server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { WriteTool } from '../src/tools/write.js';
import { Permissions } from '../src/permissions.js';
import { MockUI } from '../src/ui.js';
import { MockProvider, text, toolUse } from './mock-provider.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeRegistry() {
  const reg = new ToolRegistry();
  for (const t of [ReadTool, WriteTool]) reg.register(t);
  return reg;
}

test('non-interactive UI: approve() auto-denies without consuming stdin answers', async () => {
  const ui = new MockUI({ answers: ['y'], interactive: false });
  const d = await ui.approve('Write', '/x');
  assert.equal(d, 'n');
  assert.equal(ui.autoDenials, 1);
  assert.equal(ui.answers.length, 1, 'must not block on or consume stdin');
  assert.deepEqual(await ui.askQuestions([{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }]), {});
});

test('non-interactive loop: tool denied with actionable message, run continues, denials counted', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-print-'));
  const ui = new MockUI({ interactive: false });
  const provider = new MockProvider([
    toolUse('w1', 'Write', { file_path: join(cwd, 'x.txt'), content: 'x' }),
    text('switched to a read-only summary'),
  ]);
  const ctx = { cwd, readSet: new Set(), state: {}, sessionId: 's', ui, permissions: new Permissions('default'), config: { maxTokens: 256, maxContextTokens: 100000 } };
  const res = await runLoop({
    provider, registry: makeRegistry(), system: 'sys',
    messages: [{ role: 'user', content: 'write a file' }], ctx, ui,
    permissions: ctx.permissions, config: ctx.config,
  });
  const toolMsg = res.messages[2];
  assert.equal(toolMsg.content[0].is_error, true);
  assert.match(toolMsg.content[0].content, /Non-interactive mode: Write was auto-denied/);
  assert.match(toolMsg.content[0].content, /-y to auto-approve/);
  assert.equal(res.denials, 1);
  assert.match(res.finalText, /read-only summary/, 'model gets a chance to continue');
});

// --- spawn-level regression against a fake Anthropic SSE endpoint ----------

function fakeLLMServer({ withWriteTool }) {
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of events) res.write(`event: ${ev.type || 'x'}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  };
  const server = http.createServer((req, res) => {
    req.resume(); // drain the body so 'end' fires; the stub only reads the URL
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 3 }));
        return;
      }
      if (withWriteTool) {
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/x","content":"y"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ];
        withWriteTool.seen++;
        if (withWriteTool.seen === 1) return sse(res, events);
        return sse(res, [
          { type: 'message_start', message: { usage: { input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done read-only' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]);
      }
      return sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello cowcat' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-print-'));
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    mkdirSync(home, { recursive: true });
    // pre-trust the working dir so these tests isolate print-mode behavior
    writeFileSync(join(home, 'config.json'), JSON.stringify({ trustedProjects: [cwd] }));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), ...args], {
      env: { ...process.env, COWCAT_HOME: home, ...env },
      cwd,
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const BASE_ENV = (port) => ({
  COWCAT_PROVIDER: 'anthropic',
  COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
  COWCAT_API_KEY: 'test-key',
  COWCAT_MODEL: 'fake-model',
  COWCAT_ANIMATION: 'off',
});

test('print mode: final answer printed exactly once (no stream + print duplication)', async () => {
  const { server, port } = await fakeLLMServer({});
  try {
    const res = await runCli(['-p', 'say hi'], BASE_ENV(port));
    assert.equal(res.code, 0, res.err);
    const occurrences = res.out.split('hello cowcat').length - 1;
    assert.equal(occurrences, 1, `expected exactly one copy, stdout was:\n${res.out}`);
  } finally {
    server.close();
  }
});

test('print mode: approval auto-denied, actionable message shown, exit code non-zero', async () => {
  const state = { seen: 0 };
  const { server, port } = await fakeLLMServer({ withWriteTool: state });
  try {
    const res = await runCli(['-p', 'please write a file'], BASE_ENV(port));
    assert.equal(res.code, 2, `expected exit 2, got ${res.code}: ${res.out}${res.err}`);
    assert.match(res.out, /auto-denied/);
    assert.match(res.out, /done read-only/);
  } finally {
    server.close();
  }
});
