// P1 wave 2: hooks core subset + MCP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadHooks, fireHooks, hooksDisabled, updateHooksConfig, hookPayload,
} from '../src/hooks.js';
import {
  McpClient, connectAll, mcpToolAdapter, loadMcpConfigs, mcpTrustedList, trustMcpServer,
} from '../src/mcp.js';
import { runLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { BashTool } from '../src/tools/bash.js';
import { MockProvider, text, toolUse } from './mock-provider.js';
import { MockUI } from '../src/ui.js';
import { Permissions } from '../src/permissions.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs');

function setupHome() {
  const saved = process.env.COWCAT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    home,
    restore: () => { if (saved === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = saved; },
  };
}

// --- P1-3 hooks ---------------------------------------------------------------

test('P1-3: PreToolUse command deny feeds the reason back (via runLoop)', async () => {
  const { restore } = setupHome();
  try {
    writeFileSync(join(process.env.COWCAT_HOME, 'config.json'), JSON.stringify({
      hooks: { PreToolUse: [{ type: 'command', command: process.platform === 'win32' ? 'echo BLOCKED-HOOK & exit /b 1' : 'echo BLOCKED-HOOK; exit 1' }] },
    }));
    const hooks = loadHooks({ hooks: { PreToolUse: [{ type: 'command', command: 'echo BLOCKED-HOOK' }] } });
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-hook-'));
    const ctx = {
      cwd, readSet: new Set(), state: {}, sessionId: 's', ui: new MockUI(),
      permissions: new Permissions('yolo'), config: { maxTokens: 64, maxContextTokens: 10000 },
      hooks: { ...hooks, sessionFile: '/tmp/s.jsonl', cwd },
    };
    const registry = new ToolRegistry();
    registry.register(BashTool);
    const provider = new MockProvider([
      toolUse('b1', 'Bash', { command: 'echo hi' }),
      text('recovered'),
    ]);
    const res = await runLoop({
      provider, registry, system: 's', messages: [{ role: 'user', content: 'run' }], ctx,
      ui: ctx.ui, permissions: ctx.permissions, config: ctx.config,
    });
    const toolMsg = res.messages[2];
    assert.equal(toolMsg.content[0].is_error, true);
    assert.match(toolMsg.content[0].content, /Denied by PreToolUse hook: BLOCKED-HOOK/);
    assert.match(res.finalText, /recovered/);
  } finally {
    restore();
  }
});

test('P1-3: once hooks remove themselves from config after firing', async () => {
  const { home, restore } = setupHome();
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      hooks: { Stop: [{ type: 'command', command: 'echo ran', once: true }] },
    }));
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    const hooks = loadHooks(cfg);
    assert.equal(hooks.count, 1);
    await fireHooks(hooks, 'Stop', hookPayload('Stop', {}, { sessionFile: 'x', cwd: home }));
    const after = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal((after.hooks.Stop || []).length, 0, 'once hook auto-removed from state');
    assert.equal(hooks.count, 0);
  } finally {
    restore();
  }
});

test('P1-3: a hook that exits without reading stdin does not take the process down', async () => {
  // Regression (found by CI on Linux, invisible on Windows): the payload write to
  // a hook's stdin failed with EPIPE when the command had already exited — any
  // `exit 0`-style hook, or a child killed on timeout. Without a stream error
  // handler that was an *uncaught* exception and the whole CLI died.
  const cmd = process.platform === 'win32' ? 'exit /b 0' : 'exit 0';
  const hooks = loadHooks({ hooks: { PreToolUse: [{ type: 'command', command: cmd, timeout: 5000 }] } });
  const r = await fireHooks(hooks, 'PreToolUse', { tool: 'Bash', cwd: tmpdir() }, { blocking: true });
  assert.equal(r.denied, false);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].ok, true, 'the hook itself ran fine; only its stdin was closed');
});

test('P1-3: command hook times out and (blocking) denies; async hooks do not block', async () => {
  const slow = { type: 'command', command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1 >NUL' : 'sleep 30', timeout: 1 };
  const hooks = loadHooks({ hooks: { PreToolUse: [slow] } });
  const t0 = Date.now();
  const r = await fireHooks(hooks, 'PreToolUse', { tool: 'Bash' }, { blocking: true });
  assert.ok(Date.now() - t0 < 15_000, 'timeout must kill the hook');
  assert.equal(r.denied, true);
  assert.match(r.reason, /timed out/);

  // non-blocking events also resolve after the timeout kill (no 30s hang)
  const t1 = Date.now();
  await fireHooks(loadHooks({ hooks: { Stop: [slow] } }), 'Stop', {}, {});
  assert.ok(Date.now() - t1 < 8000, 'stop hook must not hang on a dead child');
});

test('P1-3: http hooks — 4xx denies with body reason, network error allows with warning', async () => {
  const denyFetch = async () => ({ ok: false, status: 403, text: async () => 'forbidden by proxy\nmore' });
  const hooks = loadHooks({ hooks: { PreToolUse: [{ type: 'http', url: 'https://h/x' }] } });
  const r = await fireHooks(hooks, 'PreToolUse', { tool: 'Bash' }, { blocking: true, fetchImpl: denyFetch });
  assert.equal(r.denied, true);
  assert.equal(r.reason, 'forbidden by proxy');

  const warns = [];
  const netErr = async () => { throw new Error('ECONNREFUSED'); };
  const r2 = await fireHooks(loadHooks({ hooks: { PreToolUse: [{ type: 'http', url: 'https://h/x' }] } }), 'PreToolUse', {}, { blocking: true, log: (m) => warns.push(m), fetchImpl: netErr });
  assert.equal(r2.denied, false);
  assert.ok(warns.some((w) => /unreachable/.test(w)));

  const okFetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  const r3 = await fireHooks(loadHooks({ hooks: { PreToolUse: [{ type: 'http', url: 'https://h/x' }] } }), 'PreToolUse', {}, { blocking: true, fetchImpl: okFetch });
  assert.equal(r3.denied, false);
});

test('P1-3: disable switch and enable/disable persistence helpers', async () => {
  assert.equal(hooksDisabled({ COWCAT_DISABLE_HOOKS: '1' }), true);
  assert.deepEqual(loadHooks({ hooks: { Stop: [{ type: 'command', command: 'x' }] } }, { COWCAT_DISABLE_HOOKS: '1' }).events.Stop, []);
  const { home, restore } = setupHome();
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ installId: 'keep', hooks: { Stop: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: 'echo two' }] } }));
    const next = updateHooksConfig((cfg) => { cfg.hooks.Stop[0].enabled = false; return cfg; });
    assert.equal(next.installId, 'keep');
    const hooks = loadHooks(next);
    assert.equal(hooks.events.Stop.length, 2);
    assert.equal(hooks.events.Stop[0].enabled, false);
    // disabled hook does not fire
    const r = await fireHooks(hooks, 'Stop', {});
    assert.equal(r.results.length, 1, 'disabled hook skipped');
  } finally {
    restore();
  }
});

// --- P1-4 MCP -----------------------------------------------------------------

test('P1-4: stdio MCP full chain — connect, tools/list, tools/call, registry adapter', async () => {
  const client = new McpClient('fake', { command: process.execPath, args: [FIXTURE] });
  try {
    await client.connect();
    assert.equal(client.tools.length, 3);
    const echo = client.tools.find((t) => t.name === 'echo');
    const adapter = mcpToolAdapter(client, 'fake', echo);
    assert.equal(adapter.name, 'mcp__fake__echo');
    const okRes = await adapter.execute({ text: 'hello mcp' });
    assert.equal(okRes.ok, true);
    assert.match(okRes.output, /echo: hello mcp/);
    const boom = mcpToolAdapter(client, 'fake', client.tools.find((t) => t.name === 'boom'));
    const badRes = await boom.execute({});
    assert.equal(badRes.ok, false, 'isError surfaces as tool error');
  } finally {
    client.stop();
  }
});

test('P1-4: failing server does not drag down the others; exit kills no orphans', async () => {
  const results = await connectAll({
    good: { command: process.execPath, args: [FIXTURE] },
    bad: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
  });
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName.good.ok, true);
  assert.equal(byName.bad.ok, false);
  assert.match(byName.bad.error, /exited/);
  byName.good.client.stop();
  byName.bad.client?.stop();
});

test('P1-4: call timeout respects COWCAT_MCP_TIMEOUT', async () => {
  process.env.COWCAT_MCP_TIMEOUT = '2000';
  const { McpClient: Client2 } = await import('../src/mcp.js');
  const client = new Client2('fake', { command: process.execPath, args: [FIXTURE] });
  try {
    await client.connect();
    const t0 = Date.now();
    await assert.rejects(() => client.callTool('hang', {}), /timed out/);
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    client.stop();
    delete process.env.COWCAT_MCP_TIMEOUT;
  }
});

test('P1-4: http transport over a mocked SSE endpoint', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = body.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {} }
      : { tools: [{ name: 'webtool', description: 'from http', inputSchema: { type: 'object', properties: {} } }] };
    return {
      ok: true,
      status: 200,
      text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
    };
  };
  const results = await connectAll({ web: { url: 'https://mcp.example/sse' } }, { fetchImpl });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].tools[0].name, 'webtool');
});

test('P1-4: config merge (project overrides user) and trust persistence', async () => {
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'x' }, shared: { command: 'user-version' } } }));
    mkdirSync(join(cwd, '.cowcat'), { recursive: true });
    writeFileSync(join(cwd, '.cowcat', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'proj-version' }, b: { url: 'https://b' } } }));
    const servers = loadMcpConfigs(cwd);
    assert.deepEqual(Object.keys(servers).sort(), ['a', 'b', 'shared']);
    assert.equal(servers.shared.command, 'proj-version', 'project level wins');

    const cfg = {};
    assert.deepEqual(mcpTrustedList(cfg), []);
    trustMcpServer(cfg, 'a');
    assert.deepEqual(mcpTrustedList(cfg), ['a']);
    const onDisk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.mcpTrusted, ['a']);
  } finally {
    restore();
  }
});
