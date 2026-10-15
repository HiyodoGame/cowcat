// v0.3.3 lifecycle: clean /exit shutdown, directory trust, /setup hot reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { isTrustedProject, trustProject } from '../src/trust.js';
import { loadConfig } from '../src/config.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function spawnCli(args, env, input, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-life-'));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), ...args], {
      env: { ...process.env, ...env },
      cwd,
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err, cwd }); });
  });
}

function keyServer({ withWriteTool } = {}) {
  const state = { seen: 0, chatKeys: [], bodies: [] };
  const sseText = (res, text) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  };
  const sseWriteTool = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/x","content":"y"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 3 }));
        return;
      }
      state.chatKeys.push(req.headers['x-api-key']);
      state.bodies.push(body);
      state.seen++;
      if (withWriteTool && state.seen === 1) return sseWriteTool(res);
      return sseText(res, 'ok-done');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

const ENV = (port, home) => ({
  COWCAT_HOME: home,
  COWCAT_PROVIDER: 'anthropic',
  COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
  COWCAT_API_KEY: 'old-key',
  COWCAT_MODEL: 'fake-model',
  COWCAT_ANIMATION: 'off',
});

test('/exit shuts the process down cleanly within seconds (code 0)', async () => {
  const { server, port } = await keyServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const started = Date.now();
    const res = await spawnCli([], ENV(port, home), '/exit\n', 8000);
    assert.equal(res.code, 0, `exit code ${res.code}, stderr: ${res.err}`);
    assert.ok(Date.now() - started < 8000, 'must not hang');
  } finally {
    server.close();
  }
});

test('trust: unit — persist merges and keeps installId; isTrusted reflects state', () => {
  const saved = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  try {
    const cfg = loadConfig(); // creates installId
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    assert.equal(isTrustedProject(cfg, cwd), false);
    trustProject(cfg, cwd);
    assert.equal(isTrustedProject(cfg, cwd), true);
    const onDisk = JSON.parse(readFileSync(join(process.env.COWCAT_HOME, 'state.json'), 'utf8'));
    assert.ok(onDisk.trustedProjects.includes(cwd));
    assert.equal(onDisk.installId, cfg.installId, 'installId must survive the trust write');
  } finally {
    if (saved === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = saved;
  }
});

test('trust: declining the dialog keeps the session read-only and writes nothing', async () => {
  const { server, port } = await keyServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const res = await spawnCli([], ENV(port, home), 'n\n/exit\n');
    assert.equal(res.code, 0);
    assert.match(res.out, /Trust the files in /, 'trust dialog shown');
    assert.match(res.out, /read-only/, 'untrusted consequence explained');
    assert.match(res.out, /mode: plan/, 'status bar shows plan mode');
    const cfgFile = join(home, 'config.json');
    if (existsSync(cfgFile)) {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      assert.ok(!(cfg.trustedProjects || []).includes(res.cwd), 'declining must not persist trust');
    }
  } finally {
    server.close();
  }
});

test('trust: accepting persists the cwd and starts in default mode', async () => {
  const { server, port } = await keyServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const res = await spawnCli([], ENV(port, home), 'y\n/exit\n');
    assert.equal(res.code, 0);
    const cfg = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.ok(cfg.trustedProjects.includes(res.cwd), 'y must persist trust');
    assert.match(res.out, /mode: default/);
  } finally {
    server.close();
  }
});

test('untrusted + -p: no prompt, writes auto-rejected in plan mode', async () => {
  const { server, port, state } = await keyServer({ withWriteTool: true });
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const res = await spawnCli(['-p', 'please WRITE a file'], ENV(port, home));
    assert.match(res.out, /Plan mode is read-only/, 'plan denial surfaced to the user');
    assert.ok(!/Trust the files in/.test(res.out), 'no trust prompt in non-interactive mode');
    assert.equal(res.code, 0, 'model continued read-only, no denial exit');
    assert.ok(!state.bodies.some((b) => b.includes('evil')), 'write never executed');
  } finally {
    server.close();
  }
});

test('/setup hot-reloads config: the next turn uses the new API key', async () => {
  const { server, port, state } = await keyServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    // trust the folder first (answer y), then /setup: pick the custom endpoint
    // (the legacy four-question flow) with the fake URL + new key, then chat
    const input = `y\n/setup\ncustom\nanthropic\nhttp://127.0.0.1:${port}\nbrand-new-key\nm\nhello\n/exit\n`;
    const res = await spawnCli([], ENV(port, home), input);
    assert.match(res.out, /已写入|saved to/, 'wizard saved config');
    assert.match(res.out, /✓ API connectivity/, 'doctor-style check ran with the new key');
    const helloIdx = state.bodies.findIndex((b) => b.includes('"content":"hello"') || b.includes('hello'));
    assert.ok(helloIdx >= 0, 'a chat request for "hello" was made');
    assert.equal(state.chatKeys[helloIdx], 'brand-new-key', 'hot reload: new key used without restart');
  } finally {
    server.close();
  }
});

// Model asks for a background Bash on turn 1, answers on turn 2. Before the
// fix the print path returned without killAll(), and the detached exec child
// kept the event loop alive until the command itself finished — a silent hang.
function sseBashBackground(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"node -e \\"setTimeout(()=>{},60000)\\"","run_in_background":true}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}

test('-p with a run_in_background Bash exits promptly instead of hanging on the child', async () => {
  const state = { seen: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 3 }));
        return;
      }
      state.seen++;
      if (state.seen === 1) return sseBashBackground(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const ev of [
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bg-started' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const port = server.address().port;
    const started = Date.now();
    const res = await spawnCli(['-p', '-y', 'start something in the background'], ENV(port, home), null, 15000);
    assert.match(res.out, /bg-started/, 'final answer printed');
    assert.equal(res.code, 0, `exit code ${res.code}, stderr: ${res.err}`);
    assert.ok(Date.now() - started < 15000, 'must not wait for the 60s background child');
  } finally {
    server.close();
  }
});

// Slash commands are only reachable through the REPL, so no unit test touched
// them — which is how `writeState` stayed an unimported identifier that bin
// called from /panel and /sandbox (/sandbox off killed the CLI with a
// ReferenceError). Drive the non-network commands through a piped session.
test('REPL: safe slash commands run to completion (regression — /sandbox hit an undefined identifier)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  const cmds = [
    '/status', '/cost', '/context', '/todos', '/tasks', '/agents', '/skills',
    '/permissions', '/hooks', '/mcp', '/diff', '/output', '/model', '/thinking',
    '/panel',        // TUI-only: must degrade with a message, never crash
    '/sandbox off',  // both of these used to throw `writeState is not defined`
    '/sandbox light',
    '/theme light', '/clear', '/help', '/exit',
  ];
  const env = {
    COWCAT_HOME: home,
    COWCAT_PROVIDER: 'anthropic',
    COWCAT_API_KEY: '',                     // no key: probe skipped, no network
    COWCAT_BASE_URL: 'http://127.0.0.1:9',  // never contacted without a key
    COWCAT_MODEL: 'fake-model',
    COWCAT_ANIMATION: 'off',
  };
  // leading "y" answers the untrusted-dir prompt so it cannot eat a command line
  const res = await spawnCli([], env, `y\n${cmds.join('\n')}\n`, 30000);

  assert.equal(res.code, 0, `exit code ${res.code}\nstderr: ${res.err}`);
  assert.doesNotMatch(res.err, /ReferenceError|is not defined|TypeError/,
    'an undefined identifier must not reach the REPL');
  assert.doesNotMatch(res.out, /ReferenceError|is not defined/);

  assert.match(res.out, /sandbox: light/, '/sandbox reported the new mode');
  assert.match(res.out, /panel/i, '/panel degraded with a message in line mode');
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  assert.equal(state.sandbox, 'light', '/sandbox persisted through writeState');
  assert.equal(state.theme, 'light', '/theme persisted through persistTheme');
});

test('-p fires due cron jobs before the user prompt; stdout keeps only the answer', async () => {
  const { server, port, state } = await keyServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const past = new Date(Date.now() - 60_000).toISOString();
    // No sessionId: a legacy job fires in any session (the CLI's session id is
    // generated at runtime, so the test cannot know it up front).
    writeFileSync(join(home, 'crons.json'), JSON.stringify([
      { id: 'c1', cron: null, prompt: 'CRON-JOB-PROMPT', recurring: false, nextFireAt: past, createdAt: past },
    ]));

    const res = await spawnCli(['-p', 'USER-PROMPT-HERE'], ENV(port, home));
    assert.equal(res.code, 0, `exit code ${res.code}, stderr: ${res.err}`);

    const cronIdx = state.bodies.findIndex((b) => b.includes('CRON-JOB-PROMPT'));
    const userIdx = state.bodies.findIndex((b) => b.includes('USER-PROMPT-HERE'));
    assert.ok(cronIdx >= 0, 'the scheduled turn reached the model in one-shot mode');
    assert.ok(userIdx >= 0, 'the user prompt still ran');
    assert.ok(cronIdx < userIdx, 'cron turn fires before the user prompt');

    assert.match(res.err, /\[cron\] firing c1/, 'cron banner goes to stderr, not stdout');
    assert.ok(!res.out.includes('CRON-JOB-PROMPT'), 'cron prompt never leaks into the printed answer');
    assert.match(res.out, /ok-done/, 'the user prompt answer is what stdout carries');

    const remaining = JSON.parse(readFileSync(join(home, 'crons.json'), 'utf8'));
    assert.equal(remaining.length, 0, 'one-shot job consumed and removed');
  } finally {
    server.close();
  }
});
