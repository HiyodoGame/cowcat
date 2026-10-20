import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  McpClient,
  NodeProcess,
  defaultSandboxProfile,
  nodePlatform,
  selectMcpServers,
  startMcpServers,
  type ProcessHandle,
  type ResolvedMcpSettings,
  type SandboxProfile,
  type ToolPort,
} from '../src/index.js';

const SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.js', import.meta.url));
const CWD = process.cwd();
const platform = nodePlatform({ env: process.env });

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function baseTool(name: string): ToolPort {
  return {
    spec: { name, description: 'a built-in tool', risk: 'read', inputSchema: { type: 'object', properties: {} } },
    run: () => Promise.resolve({ ok: true, output: '' }),
  };
}

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

async function startServer(mode: string, options: { readonly sandbox?: SandboxProfile; readonly env?: Record<string, string> } = {}): Promise<ProcessHandle> {
  const controller = new AbortController();
  return new NodeProcess({ platform }).open(
    {
      argv: [process.execPath, SERVER, mode],
      cwd: CWD,
      env: { ...inheritedEnv(), ...options.env },
      sandbox: options.sandbox ?? defaultSandboxProfile({ mode: 'off' }),
    },
    controller.signal,
  );
}

test('a modern server is discovered with server/discover and its tools are callable', async (t) => {
  const handle = await startServer('modern');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });

  await client.start();
  assert.equal(client.era, 'modern');
  assert.equal(client.protocolVersion, '2026-07-28');

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['echo', 'fail', 'env', 'crash', 'hang', 'change']);

  const ok = await client.callTool('echo', { text: 'hi' }, new AbortController().signal);
  assert.equal(ok.ok, true);
  assert.match(ok.output, /echo: hi/u);

  const failed = await client.callTool('fail', {}, new AbortController().signal);
  assert.equal(failed.ok, false);
  assert.match(failed.output, /deliberate failure/u);
});

test('a legacy server is reached through the initialize fallback', async (t) => {
  const handle = await startServer('legacy');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });

  await client.start();
  assert.equal(client.era, 'legacy');
  assert.equal(client.protocolVersion, '2025-11-25');

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);
  const ok = await client.callTool('echo', { text: 'old' }, new AbortController().signal);
  assert.equal(ok.ok, true);
  assert.match(ok.output, /echo: old/u);
});

test('a crashed server fails the call instead of restarting', async (t) => {
  const handle = await startServer('modern');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });
  await client.start();

  const crashed = await client.callTool('crash', {}, new AbortController().signal);
  assert.equal(crashed.ok, false);
  assert.match(crashed.output, /exited/u);

  // A later call must fail at once rather than wait for the request timeout.
  const after = await client.callTool('echo', { text: 'after' }, new AbortController().signal);
  assert.equal(after.ok, false);
  assert.match(after.output, /no restart is attempted/u);
});

test('cancelling a call terminates the server process', async (t) => {
  const handle = await startServer('modern');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });
  await client.start();

  const controller = new AbortController();
  const pending = client.callTool('hang', {}, controller.signal);
  setTimeout(() => {
    controller.abort();
  }, 50);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.output, /cancelled/u);
});

test('the process gateway strips credential-shaped variables before the server sees them', async (t) => {
  const handle = await startServer('modern', {
    // `light` redacts; `off` would hand the value over, which is the contrast the test needs.
    sandbox: defaultSandboxProfile(),
    env: { MCP_TEST_TOKEN: 'super-secret-value' },
  });
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });
  await client.start();

  const seen = await client.callTool('env', {}, new AbortController().signal);
  assert.equal(seen.ok, true);
  assert.match(seen.output, /token=missing/u);
  assert.ok(!seen.output.includes('super-secret-value'));
});

test('server definitions are trusted by layer and project env is ignored', () => {
  const mcp: ResolvedMcpSettings = {
    servers: {
      fromProject: { settings: { command: 'node', args: ['p.js'], env: { SECRET: 'x' } }, origin: 'project' },
      fromUser: { settings: { command: 'node', args: ['u.js'], env: { OK: '1' } }, origin: 'user' },
    },
  };

  const untrusted = selectMcpServers(mcp, { trusted: false });
  assert.deepEqual(Object.keys(untrusted.servers), ['fromUser']);
  assert.match(untrusted.warnings.join('\n'), /skipped 1 server/u);

  const trusted = selectMcpServers(mcp, { trusted: true });
  assert.deepEqual(Object.keys(trusted.servers).sort(), ['fromProject', 'fromUser']);
  assert.equal(trusted.servers['fromProject']?.env, undefined);
  assert.match(trusted.warnings.join('\n'), /env ignored/u);
});

test('startMcpServers namespaces tools, refuses collisions, and skips bad server names', async () => {
  const warnings: string[] = [];
  const servers = await startMcpServers({
    servers: {
      fake: { command: process.execPath, args: [SERVER, 'modern'] },
      'bad name': { command: process.execPath, args: [SERVER, 'modern'] },
    },
    cwd: CWD,
    env: process.env,
    sandbox: defaultSandboxProfile(),
    process: new NodeProcess({ platform }),
    version: 'test',
    baseTools: new Map([['TodoWrite', baseTool('TodoWrite')]]),
    warn: (message) => {
      warnings.push(message);
    },
    signal: new AbortController().signal,
  });

  try {
    const names = [...servers.table.values()].map((tool) => tool.spec.name).filter((name) => name.startsWith('mcp__')).sort();
    assert.deepEqual(names, [
      'mcp__fake__change',
      'mcp__fake__crash',
      'mcp__fake__echo',
      'mcp__fake__env',
      'mcp__fake__fail',
      'mcp__fake__hang',
    ]);
    assert.ok(servers.table.has('TodoWrite'));
    const echo = servers.table.get('mcp__fake__echo');
    assert.equal(echo?.spec.risk, 'exec');
    assert.match(warnings.join('\n'), /invalid server name "bad name"/u);

    const statuses = new Map(servers.statuses.map((status) => [status.name, status]));
    assert.equal(statuses.get('fake')?.connected, true);
    assert.equal(statuses.get('fake')?.toolCount, 6);
    assert.equal(statuses.get('bad name')?.connected, false);
  } finally {
    await servers.close();
  }

  const conflictWarnings: string[] = [];
  const conflicted = await startMcpServers({
    servers: { fake: { command: process.execPath, args: [SERVER, 'modern'] } },
    cwd: CWD,
    env: process.env,
    sandbox: defaultSandboxProfile(),
    process: new NodeProcess({ platform }),
    version: 'test',
    baseTools: new Map([['mcp__fake__echo', baseTool('mcp__fake__echo')]]),
    warn: (message) => {
      conflictWarnings.push(message);
    },
    signal: new AbortController().signal,
  });
  try {
    const names = [...conflicted.table.values()].map((tool) => tool.spec.name);
    assert.deepEqual(names, ['mcp__fake__echo']);
    assert.equal(conflicted.statuses[0]?.connected, false);
    assert.match(conflictWarnings.join('\n'), /collides with an existing tool/u);
  } finally {
    await conflicted.close();
  }
});

test('tools/list follows nextCursor across pages', async (t) => {
  const handle = await startServer('paginated');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });

  await client.start();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['echo', 'fail', 'env', 'crash', 'hang', 'change']);
  assert.match(listed.warnings.join('\n'), /2 pages/u);
});

test('a legacy server pushes list_changed without a subscription request', async (t) => {
  const handle = await startServer('legacy');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });
  await client.start();

  let changes = 0;
  client.onToolsChanged(() => {
    changes += 1;
  });
  assert.equal(await client.watchTools(), null);

  const changed = await client.callTool('change', {}, new AbortController().signal);
  assert.equal(changed.ok, true);
  await until('the list_changed notification', () => changes > 0);

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'added'));
});

test('a modern server is subscribed with subscriptions/listen', async (t) => {
  const handle = await startServer('modern');
  const client = new McpClient(handle, { clientVersion: 'test' });
  t.after(async () => {
    await client.close();
  });
  await client.start();

  let changes = 0;
  client.onToolsChanged(() => {
    changes += 1;
  });
  assert.equal(await client.watchTools(), null);

  await client.callTool('change', {}, new AbortController().signal);
  await until('the subscribed list_changed notification', () => changes > 0);
});

test('a tool-list change swaps only that server\'s tools in the live table', async () => {
  const warnings: string[] = [];
  const servers = await startMcpServers({
    servers: { fake: { command: process.execPath, args: [SERVER, 'modern'] } },
    cwd: CWD,
    env: process.env,
    sandbox: defaultSandboxProfile(),
    process: new NodeProcess({ platform }),
    version: 'test',
    baseTools: new Map([['TodoWrite', baseTool('TodoWrite')]]),
    warn: (message) => {
      warnings.push(message);
    },
    signal: new AbortController().signal,
  });

  try {
    assert.equal(servers.table.has('mcp__fake__added'), false);
    const change = servers.table.get('mcp__fake__change');
    assert.ok(change !== undefined);
    const result = await change.run({}, new AbortController().signal, { networkApproved: false });
    assert.equal(result.ok, true);

    await until('the new tool to appear', () => servers.table.has('mcp__fake__added'));
    assert.ok(servers.table.has('TodoWrite'));
    assert.ok(servers.table.has('mcp__fake__echo'));
    const status = servers.statuses.find((entry) => entry.name === 'fake');
    assert.equal(status?.toolCount, 7);
  } finally {
    await servers.close();
  }
});
