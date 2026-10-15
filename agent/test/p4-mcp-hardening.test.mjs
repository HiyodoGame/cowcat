// P4 MCP hardening: pagination, session-id header, SSE multi-frame bodies,
// notifications, SIGKILL escalation, dead-pipe requests, config type guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient, loadMcpConfigs } from '../src/mcp.js';
import { ListMcpResourcesTool } from '../src/tools/mcpresources.js';
import { ToolRegistry } from '../src/tools/registry.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs');
const stdio = (env = {}) => ({ command: process.execPath, args: [FIXTURE], env });

function setupHome() {
  const saved = process.env.COWCAT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    home,
    restore: () => { if (saved === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = saved; },
  };
}

test('mcp: connect budget caps a hung server (deadline clamps the per-call timeout)', async () => {
  const client = new McpClient('slow', stdio({ FAKE_MCP_HANG_INIT: '1' }), { deadline: Date.now() + 400 });
  const t0 = Date.now();
  await assert.rejects(() => client.connect(), /timed out|timeout/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `budget should cut the wait short (took ${elapsed}ms, per-call timeout is 60s)`);
  client.stop();
});

test('mcp: a failing server reports the last stderr line, not just an exit code', async () => {
  const client = new McpClient('kaboom', stdio({ FAKE_MCP_STDERR: 'Missing API key for provider anthropic' }));
  await assert.rejects(
    () => client.connect(),
    /server exited \(code 9\): Missing API key for provider anthropic/,
  );
});

// Windows-only: the documented config says "command": "npx" but .cmd shims
// cannot be spawned directly — the launcher retries through cmd.exe.
const winOnly = { skip: process.platform !== 'win32' ? 'Windows shim behaviour' : false };

test('mcp: a bare .cmd shim on PATH launches through cmd.exe', winOnly, async () => {
  const shimDir = mkdtempSync(join(tmpdir(), 'cowcat-shim-'));
  const pidFile = join(shimDir, 'server.pid');
  writeFileSync(join(shimDir, 'fake-mcp.cmd'), `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`);

  const client = new McpClient('shim', {
    command: 'fake-mcp', // no extension, exactly like "npx" in the docs
    args: [],
    env: { PATH: `${shimDir};${process.env.PATH}`, FAKE_MCP_PIDFILE: pidFile },
  });
  await client.connect();
  assert.equal(client.tools.length, 3, 'the shim launched the real server');
  const child = client.transport.child;
  assert.equal(child.spawnfile, process.env.ComSpec || 'cmd.exe', 'launched via the command processor');

  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0, 'fixture recorded its pid');
  client.stop();

  // the server is a grandchild (cmd.exe -> node): killing only cmd.exe would
  // leave it orphaned, so wait for the pid to actually disappear
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false, `grandchild pid ${pid} must be reaped with the tree`);
});

test('mcp: a genuinely missing command still reports the original launch error', winOnly, async () => {
  const client = new McpClient('nope', { command: 'definitely-missing-cowcat-9f', args: [] });
  await assert.rejects(() => client.connect(), /server exited \(code \d+\)|ENOENT/);
});

test('mcp: prompts are discovered on connect and fetched with arguments', async () => {
  const client = new McpClient('prompts', stdio());
  try {
    await client.connect();
    assert.deepEqual(client.prompts.map((p) => p.name), ['greet', 'status'], 'prompts/list ran during connect');
    assert.equal(client.prompts[0].arguments[0].name, 'name');

    const got = await client.getPrompt('greet', { name: 'World' });
    assert.match(got.text, /Hello World!/, 'text content is injected verbatim');
    assert.match(got.text, /\[assistant\] \(greeting goes here\)/, 'non-user roles are labelled, not impersonated');
    assert.equal(got.description, 'Greet someone');

    const plain = await client.getPrompt('status');
    assert.match(plain.text, /Report the fake status/);
    await assert.rejects(() => client.getPrompt('nope'), /Unknown prompt/);
  } finally {
    client.stop();
  }
});

test('mcp: resource templates are listed (and reached through ListMcpResources)', async () => {
  const client = new McpClient('templates', stdio());
  try {
    await client.connect();
    const templates = await client.listResourceTemplates();
    assert.deepEqual(templates.map((t) => t.uriTemplate), ['memo://note/{id}']);

    const out = await ListMcpResourcesTool.execute({}, { mcpClients: new Map([['fake', client]]) });
    assert.equal(out.ok, true);
    assert.match(out.output, /\[fake\] template memo:\/\/note\/\{id\}/, 'templates show up next to the static resources');
    assert.match(out.output, /memo:\/\/welcome/, 'static resources still listed');
  } finally {
    client.stop();
  }
});

test('mcp: a server without the prompts capability is not a failure', async () => {
  // FAKE_MCP_NO_PROMPTS simulates a server that answers Method not found
  const client = new McpClient('noprompts', stdio({ FAKE_MCP_NO_PROMPTS: '1' }));
  try {
    await client.connect();
    assert.equal(client.prompts.length, 0);
    assert.ok(client.tools.length > 0, 'tools still work');
  } finally {
    client.stop();
  }
});

test('mcp: an SSE stream that stays open after the response does not stall the call', async () => {
  // The spec allows a server to keep the response stream open (keep-alive
  // comment frames, further notifications) — the official SDK's keep-alive and
  // any holding proxy do that. Buffering the whole body first (await res.text())
  // made every call hang until COWCAT_MCP_TIMEOUT even though the answer had
  // already arrived.
  let ticker;
  const fetchImpl = async (url, opts) => {
    const req = JSON.parse(opts.body);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'webtool', description: 'x', inputSchema: { type: 'object', properties: {} } }] } })}\n\n`,
        ));
        // answer delivered — keep the stream open instead of ending it
        ticker = setInterval(() => {
          try { controller.enqueue(enc.encode(': keepalive\n\n')); } catch { clearInterval(ticker); }
        }, 25);
        ticker.unref?.();
      },
      cancel() { clearInterval(ticker); },
    });
    return { ok: true, status: 200, headers: { get: () => null }, body: stream };
  };
  const client = new McpClient('holding', { url: 'https://mcp.example/sse' }, { fetchImpl });
  const started = Date.now();
  const res = await client.transport.request('tools/list', {});
  const ms = Date.now() - started;
  assert.equal(res.tools.length, 1, 'the frame that arrived first is the answer');
  assert.ok(ms < 1000, `must resolve without waiting for the stream to end (took ${ms}ms)`);
  clearInterval(ticker);
});

test('mcp: resources/list follows nextCursor too (a cursor hides resources past page 1)', async () => {
  const client = new McpClient('paged-res', stdio({ FAKE_MCP_PAGE: '1' }));
  try {
    await client.connect();
    const res = await client.listResources();
    assert.deepEqual(res.map((r) => r.uri), ['memo://welcome', 'blob://logo'], 'both pages merged');
  } finally {
    client.stop();
  }
});

test('mcp: tools/list follows nextCursor and collects every page', async () => {
  process.env.FAKE_MCP_PAGE = '2'; // 3 tools served 2 + 1
  const client = new McpClient('paged', stdio({ FAKE_MCP_PAGE: '2' }));
  try {
    await client.connect();
    assert.equal(client.tools.length, 3, 'all pages merged, not just the first');
    assert.deepEqual(client.tools.map((t) => t.name), ['echo', 'boom', 'hang']);
  } finally {
    client.stop();
    delete process.env.FAKE_MCP_PAGE;
  }
});

test('mcp: SIGTERM then SIGKILL for a server that ignores SIGTERM', async () => {
  process.env.COWCAT_MCP_KILL_GRACE = '200';
  const client = new McpClient('stubborn', stdio({ FAKE_MCP_IGNORE_SIGTERM: '1' }));
  try {
    await client.connect();
    const child = client.transport.child;
    client.stop();
    // Windows has no catchable SIGTERM (stop() goes through taskkill there), so
    // poll rather than assume a fixed delay.
    const started = Date.now();
    while (child.exitCode === null && child.signalCode === null && Date.now() - started < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      'the stubborn child is gone after the SIGKILL escalation',
    );
  } finally {
    delete process.env.COWCAT_MCP_KILL_GRACE;
  }
});

test('mcp: a request after the server exited rejects cleanly instead of writing to a dead pipe', async () => {
  const client = new McpClient('dead', stdio());
  await client.connect();
  const child = client.transport.child;
  client.stop();
  const started = Date.now();
  while (child.exitCode === null && child.signalCode === null && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'server really exited');
  await assert.rejects(() => client.callTool('echo', { text: 'hi' }), /server exited|failed to write|EPIPE/);
});

test('mcp: http transport carries the mcp-session-id header on later requests', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push({ method: body.method, sid: opts.headers['mcp-session-id'], hasId: body.id != null, clientInfo: body.params?.clientInfo });
    // the session minting server rejects any request without the header
    if (body.method !== 'initialize' && !opts.headers['mcp-session-id']) {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'missing session' };
    }
    const result = body.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {} }
      : { tools: [{ name: 'webtool', description: 'from http', inputSchema: { type: 'object', properties: {} } }] };
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'mcp-session-id' ? 'sess-42' : null) },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    };
  };
  const client = new McpClient('web', { url: 'https://mcp.example/sse' }, { fetchImpl });
  await client.connect();
  assert.equal(client.tools[0].name, 'webtool', 'tools/list succeeded with the session header');
  const listCall = seen.find((s) => s.method === 'tools/list');
  assert.equal(listCall.sid, 'sess-42', 'session id echoed on the follow-up request');
  const initCall = seen.find((s) => s.method === 'initialize');
  assert.equal(initCall.sid, undefined, 'initialize itself has no session header yet');
  // the handshake version must not drift from package.json (it was hardcoded to
  // an old release once)
  const pkgVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  assert.equal(initCall.clientInfo.version, pkgVersion, 'clientInfo reports the real package version');
  // notifications/initialized must be a real notification: no id, not awaited
  const note = seen.find((s) => s.method === 'notifications/initialized');
  assert.ok(note, 'notification was sent');
  assert.equal(note.hasId, false, 'notification carries no JSON-RPC id');
});

test('mcp: SSE bodies with a leading notification frame still parse the response', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = body.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {} }
      : { tools: [{ name: 'webtool', description: 'x', inputSchema: { type: 'object', properties: {} } }] };
    // server pushes a notification frame first, then the answer frame
    const sse = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}`,
      '',
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}`,
      '',
    ].join('\n');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => sse };
  };
  const client = new McpClient('web', { url: 'https://mcp.example/sse' }, { fetchImpl });
  await client.connect();
  assert.equal(client.tools.length, 1);
  assert.equal(client.tools[0].name, 'webtool');
});

test('mcp: mcpServers must be a plain object — arrays/strings are ignored', () => {
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: ['a', 'b'] }));
    mkdirSync(join(cwd, '.cowcat'), { recursive: true });
    writeFileSync(join(cwd, '.cowcat', 'mcp.json'), JSON.stringify({ mcpServers: 'nope' }));
    assert.deepEqual(loadMcpConfigs(cwd), {}, 'array/string shapes yield no servers');
  } finally {
    restore();
  }
});

test('mcp: project level replaces the whole server object (no field-level merge)', () => {
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'user-cmd', args: ['--x'] } } }));
    mkdirSync(join(cwd, '.cowcat'), { recursive: true });
    writeFileSync(join(cwd, '.cowcat', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { url: 'https://proj' } } }));
    const servers = loadMcpConfigs(cwd);
    assert.equal(servers.shared.url, 'https://proj');
    assert.equal(servers.shared.command, undefined, 'user level command does not survive the override');
  } finally {
    restore();
  }
});

test('mcp: registry.unregister drops a reconnect-leftover adapter', () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'mcp__srv__echo', description: 'x', input_schema: { type: 'object' }, execute: () => ({ ok: true }) });
  assert.ok(reg.get('mcp__srv__echo'));
  assert.equal(reg.unregister('mcp__srv__echo'), true);
  assert.equal(reg.get('mcp__srv__echo'), undefined);
  assert.equal(reg.unregister('mcp__srv__echo'), false, 'idempotent');
});
