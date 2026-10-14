// P3: MCP resources — client methods + ListMcpResources/ReadMcpResource tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../src/mcp.js';
import { ListMcpResourcesTool, ReadMcpResourceTool } from '../src/tools/mcpresources.js';
import { ToolRegistry } from '../src/tools/registry.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs');

async function fixtureClient() {
  const client = new McpClient('fake', { command: process.execPath, args: [FIXTURE] });
  await client.connect();
  return client;
}

test('P3: client listResources/readResource over stdio (text + base64 + error)', async () => {
  const client = await fixtureClient();
  try {
    const resources = await client.listResources();
    assert.equal(resources.length, 2);
    assert.equal(resources[0].uri, 'memo://welcome');
    assert.equal(resources[1].mimeType, 'application/octet-stream');

    const memo = await client.readResource('memo://welcome');
    assert.equal(memo.isError, false);
    assert.match(memo.text, /hello resource/);

    const blob = await client.readResource('blob://logo');
    assert.match(blob.text, /^\[base64 application\/octet-stream\] aGVsbG8=$/);

    const gone = await client.readResource('memo://nope');
    assert.equal(gone.isError, true);
  } finally {
    client.stop();
  }
});

test('P3: ListMcpResources enumerates every connected server with uri/desc/mime', async () => {
  const client = await fixtureClient();
  try {
    const ctx = { mcpClients: new Map([['fake', client]]) };
    const res = await ListMcpResourcesTool.execute({}, ctx);
    assert.equal(res.ok, true);
    assert.match(res.output, /\[fake\] memo:\/\/welcome.*Greeting memo \(text\/plain\)/);
    assert.match(res.output, /blob:\/\/logo/);
    assert.doesNotMatch(res.output, /resources\/list failed/);
  } finally {
    client.stop();
  }
});

test('P3: ListMcpResources with no servers connected; failing server is isolated', async () => {
  const empty = await ListMcpResourcesTool.execute({}, { mcpClients: new Map() });
  assert.match(empty.output, /No MCP servers connected/);

  const client = await fixtureClient();
  try {
    const ctx = {
      mcpClients: new Map([
        ['fake', client],
        ['dead', { listResources: async () => { throw new Error('transport dead'); } }],
      ]),
    };
    const res = await ListMcpResourcesTool.execute({}, ctx);
    assert.equal(res.ok, true);
    assert.match(res.output, /\[fake\] memo:\/\/welcome/);
    assert.match(res.output, /dead: \(resources\/list failed: transport dead\)/);
  } finally {
    client.stop();
  }
});

test('P3: ReadMcpResource happy path, unknown server, missing ctx wiring', async () => {
  const client = await fixtureClient();
  try {
    const okRes = await ReadMcpResourceTool.execute({ server: 'fake', uri: 'memo://welcome' }, { mcpClients: new Map([['fake', client]]) });
    assert.equal(okRes.ok, true);
    assert.match(okRes.output, /hello resource/);

    const badServer = await ReadMcpResourceTool.execute({ server: 'nope', uri: 'memo://welcome' }, { mcpClients: new Map([['fake', client]]) });
    assert.equal(badServer.ok, false);
    assert.match(badServer.error, /MCP server not connected: nope.*fake/s);

    const noCtx = await ReadMcpResourceTool.execute({ server: 'fake', uri: 'memo://welcome' }, {});
    assert.equal(noCtx.ok, false);
    assert.match(noCtx.error, /not connected/);
  } finally {
    client.stop();
  }
});

test('P3: tools validate against the registry schema', () => {
  const reg = new ToolRegistry();
  reg.register(ListMcpResourcesTool);
  reg.register(ReadMcpResourceTool);
  assert.ok(reg.validate('ListMcpResources', {}).ok);
  assert.ok(reg.validate('ReadMcpResource', { server: 'a', uri: 'b' }).ok);
  const missing = reg.validate('ReadMcpResource', { server: 'a' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /uri is required/);
});
