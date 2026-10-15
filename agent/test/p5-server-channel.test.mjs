// Round 9: the MCP server->client channel.
//
// Covers the SSE parser, notification dispatch on both transports, the
// Streamable HTTP GET stream (reconnect + Last-Event-ID + "no stream here" +
// giving up), answers to server-initiated requests, resource subscriptions
// (catalog §15/§16) and the notification classification the host acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../src/mcp.js';
import { SseParser } from '../src/sse.js';
import { McpSubscriptions } from '../src/mcpsubs.js';
import { classifyMcpNotification, formatMcpNotification, handleMcpNotification } from '../src/mcpnotify.js';
import { SubscribeMcpResourceTool, UnsubscribeMcpResourceTool } from '../src/tools/mcpresources.js';
import { Permissions } from '../src/permissions.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(TEST_DIR, 'fixtures', 'fake-mcp.mjs');
const stdio = (env = {}) => ({ command: process.execPath, args: [FIXTURE], env });

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- SSE parser --------------------------------------------------------------

test('sse: frames, multiline data, ids, retry, comments and CRLF', () => {
  const p = new SseParser();
  const events = p.feed([
    ': keepalive\n',
    'id: e1\n',
    'event: message\n',
    'data: {"a": 1}\n',
    '\n',
    'retry: 250\n',
    'data: line one\n',
    'data: line two\n',
    '\n',
    'id: e2\r\n',
    'data: {"b": 2}\r\n',
    '\r\n',
  ].join(''));
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { data: '{"a": 1}', id: 'e1', retry: null });
  // multiline data is joined with \n (the spec), not truncated
  assert.equal(events[1].data, 'line one\nline two');
  assert.equal(events[1].retry, 250);
  assert.equal(events[1].id, null);
  assert.deepEqual(events[2], { data: '{"b": 2}', id: 'e2', retry: null });
});

test('sse: a frame split across chunks is reassembled; flush() keeps a trailing one', () => {
  const p = new SseParser();
  assert.deepEqual(p.feed('data: {"x"'), []);
  assert.deepEqual(p.feed(':1}\n'), []);
  assert.deepEqual(p.feed('\n'), [{ data: '{"x":1}', id: null, retry: null }]);
  assert.deepEqual(p.feed('id: z\ndata: tail'), []); // no blank line yet
  assert.deepEqual(p.flush(), [{ data: 'tail', id: 'z', retry: null }]);
  assert.deepEqual(p.flush(), []); // nothing left
});

// --- stdio: notifications and server-initiated requests ----------------------

test('mcp/stdio: unsolicited notifications reach the host', async () => {
  const seen = [];
  const client = new McpClient('fake', stdio({ FAKE_MCP_LOG: 'hello from server' }));
  client.onNotification = (method, params) => seen.push([method, params]);
  try {
    await client.connect();
    await waitFor(() => seen.length);
    assert.equal(seen[0][0], 'notifications/message');
    assert.equal(seen[0][1].data, 'hello from server');
  } finally {
    client.stop();
  }
});

test('mcp/stdio: a server-initiated sampling request is answered with Method not found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-cap-'));
  const capture = join(dir, 'wire.jsonl');
  const client = new McpClient('fake', stdio({ FAKE_MCP_SERVER_REQUEST: '1', FAKE_MCP_CAPTURE: capture }));
  try {
    await client.connect();
    // Without a reply the server would wait forever; silence is not an option.
    await waitFor(() => existsSync(capture) && readFileSync(capture, 'utf8').includes('9001'));
    const reply = readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).find((m) => m.id === 9001);
    assert.equal(reply.error.code, -32601);
    assert.match(reply.error.message, /sampling\/createMessage/);
  } finally {
    client.stop();
  }
});

test('mcp/stdio: a server-initiated ping is answered with an empty result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-cap-'));
  const capture = join(dir, 'wire.jsonl');
  const client = new McpClient('fake', stdio({ FAKE_MCP_SERVER_PING: '1', FAKE_MCP_CAPTURE: capture }));
  try {
    await client.connect();
    await waitFor(() => existsSync(capture) && readFileSync(capture, 'utf8').includes('9002'));
    const reply = readFileSync(capture, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).find((m) => m.id === 9002);
    assert.deepEqual(reply.result, {});
  } finally {
    client.stop();
  }
});

test('mcp: the client asks for log messages when the server offers them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-cap-'));
  const capture = join(dir, 'wire.jsonl');
  const client = new McpClient('fake', stdio({ FAKE_MCP_CAPTURE: capture, FAKE_MCP_LOG_ON_LEVEL: '1' }));
  const seen = [];
  client.onNotification = (method, params) => seen.push(params.data);
  try {
    await client.connect();
    const sent = readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const setLevel = sent.find((m) => m.method === 'logging/setLevel');
    assert.equal(setLevel.params.level, 'info', 'a conforming server stays silent without this');
    // ...and the level is honoured end to end
    await waitFor(() => seen.length);
    assert.equal(seen[0], 'level=info');
  } finally {
    client.stop();
  }
});

test('mcp: a server without the logging capability is never asked for a level', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-cap-'));
  const capture = join(dir, 'wire.jsonl');
  const client = new McpClient('fake', stdio({ FAKE_MCP_CAPTURE: capture, FAKE_MCP_NO_LOGGING: '1' }));
  try {
    await client.connect();
    const sent = readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(!sent.some((m) => m.method === 'logging/setLevel'));
  } finally {
    client.stop();
  }
});

// --- Streamable HTTP GET stream ---------------------------------------------

function sseFrame(obj, { id = null } = {}) {
  return `${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;
}

// A minimal MCP-over-HTTP server: JSON answers to POST, streaming answers to GET.
async function startHttpMcp(getHandler) {
  const state = { gets: [], posts: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET') {
      state.gets.push({ headers: req.headers });
      getHandler(req, res, state);
      return;
    }
    let msg = {};
    try { msg = JSON.parse(body || '{}'); } catch { /* ignore */ }
    state.posts.push(msg);
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } },
      }));
      return;
    }
    if (msg.id == null) { res.writeHead(202).end(); return; } // notification or reply
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    state,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

test('mcp/http: the GET stream delivers notifications and resumes with Last-Event-ID', async () => {
  const seen = [];
  let get = 0;
  const h = await startHttpMcp((req, res) => {
    get += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (get === 1) {
      res.write(sseFrame({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'first' } }, { id: 'e1' }));
      res.end(); // the server drops the stream: we must come back for more
    } else {
      res.write(sseFrame({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'warning', data: 'second' } }, { id: 'e2' }));
      // ...and keep this one open, like a real server
    }
  });
  process.env.COWCAT_MCP_STREAM_RETRY_MS = '10';
  const client = new McpClient('http', { url: h.url });
  client.onNotification = (method, params) => seen.push(params.data);
  try {
    await client.connect();
    client.startChannel();
    await waitFor(() => seen.length >= 2);
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal(h.state.gets.length, 2);
    assert.equal(h.state.gets[1].headers['last-event-id'], 'e1', 'a resumable server can replay from here');
    assert.equal(h.state.gets[1].headers['mcp-session-id'], 'sess-1', 'the session rides along');
    assert.equal(h.state.gets[1].headers.accept, 'text/event-stream');
    client.stop();
    const after = h.state.gets.length;
    await sleep(120);
    assert.equal(h.state.gets.length, after, 'stop() ends the channel for good');
  } finally {
    delete process.env.COWCAT_MCP_STREAM_RETRY_MS;
    client.stop();
    h.close();
  }
});

test('mcp/http: a 405 on GET means "no such endpoint" and is never retried', async () => {
  const h = await startHttpMcp((req, res) => { res.writeHead(405).end(); });
  process.env.COWCAT_MCP_STREAM_RETRY_MS = '10';
  const client = new McpClient('http', { url: h.url });
  try {
    await client.connect();
    client.startChannel();
    await sleep(150);
    assert.equal(h.state.gets.length, 1, 'one probe is enough');
  } finally {
    delete process.env.COWCAT_MCP_STREAM_RETRY_MS;
    client.stop();
    h.close();
  }
});

test('mcp/http: a stream that keeps dropping is retried with backoff, then reported once', async () => {
  const h = await startHttpMcp((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(); // always dies immediately
  });
  process.env.COWCAT_MCP_STREAM_RETRY_MS = '5';
  process.env.COWCAT_MCP_STREAM_ATTEMPTS = '2';
  const errors = [];
  const client = new McpClient('http', { url: h.url });
  client.onChannelError = (e) => errors.push(e.message);
  try {
    await client.connect();
    client.startChannel();
    await waitFor(() => errors.length);
    await sleep(80);
    assert.equal(errors.length, 1, 'one report, not one per retry');
    assert.match(errors[0], /gave up after 2 retries/);
    assert.equal(h.state.gets.length, 3, 'initial attempt + 2 retries');
    const after = h.state.gets.length;
    await sleep(80);
    assert.equal(h.state.gets.length, after, 'giving up means giving up');
  } finally {
    delete process.env.COWCAT_MCP_STREAM_RETRY_MS;
    delete process.env.COWCAT_MCP_STREAM_ATTEMPTS;
    client.stop();
    h.close();
  }
});

test('mcp/http: a server-initiated request on the GET stream is answered by POST', async () => {
  const h = await startHttpMcp((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: { messages: [] } }));
  });
  const client = new McpClient('http', { url: h.url });
  try {
    await client.connect();
    client.startChannel();
    await waitFor(() => h.state.posts.some((m) => m.id === 7));
    const reply = h.state.posts.find((m) => m.id === 7);
    assert.equal(reply.error.code, -32601);
    assert.equal(reply.jsonrpc, '2.0');
  } finally {
    client.stop();
    h.close();
  }
});

test('mcp/http: notifications interleaved on a POST stream are dispatched, not dropped', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'GET') return { ok: false, status: 405, headers: { get: () => null } };
    const req = JSON.parse(opts.body);
    if (req.method === 'notifications/initialized') return { ok: true, status: 202, headers: { get: () => null }, body: null };
    const enc = new TextEncoder();
    const body = [
      sseFrame({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'interleaved' } }),
      sseFrame({ jsonrpc: '2.0', id: req.id, result: { tools: [] } }),
    ].join('');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }),
    };
  };
  const client = new McpClient('http', { url: 'https://mcp.example/mcp' }, { fetchImpl });
  client.onNotification = (method, params) => seen.push(params.data);
  try {
    await client.connect();
    assert.ok(seen.length >= 1, 'a notification rode along on the POST stream');
    assert.ok(seen.every((d) => d === 'interleaved'), `unexpected payloads: ${seen.join(', ')}`);
  } finally {
    client.stop();
  }
});

test('mcp/http: multiline data frames parse (pretty-printed JSON used to be truncated)', async () => {
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'GET') return { ok: false, status: 405, headers: { get: () => null } };
    const req = JSON.parse(opts.body);
    if (req.method === 'notifications/initialized') return { ok: true, status: 202, headers: { get: () => null }, body: null };
    const json = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'multi', description: 'd', inputSchema: { type: 'object', properties: {} } }] } }, null, 2);
    const frame = `${json.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`;
    const enc = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({ start(c) { c.enqueue(enc.encode(frame)); c.close(); } }),
    };
  };
  const client = new McpClient('http', { url: 'https://mcp.example/mcp' }, { fetchImpl });
  try {
    const tools = await client.connect().then(() => client.tools);
    assert.deepEqual(tools.map((t) => t.name), ['multi']);
  } finally {
    client.stop();
  }
});

// --- subscriptions -----------------------------------------------------------

test('mcp: subscribe/unsubscribe require the capability and reach the registry', async () => {
  const subs = new McpSubscriptions();
  const client = new McpClient('fake', stdio());
  const ctx = { mcpClients: new Map([['fake', client]]), mcpSubs: subs };
  try {
    await client.connect();
    const sub = await SubscribeMcpResourceTool.execute({ uri: 'memo://welcome', reason: 'watching the memo' }, ctx);
    assert.equal(sub.ok, true, sub.error);
    assert.equal(sub.subscribed, true);
    assert.equal(sub.subscriptionId, 'mcp:fake:memo://welcome');
    assert.equal(subs.list().length, 1);
    assert.equal(subs.find('memo://welcome')[0].reason, 'watching the memo');

    // server is optional when exactly one is connected
    assert.match(sub.output, /Subscribed to memo:\/\/welcome on fake/);

    const un = await UnsubscribeMcpResourceTool.execute({ uri: 'memo://welcome' }, ctx);
    assert.equal(un.ok, true, un.error);
    assert.equal(un.unsubscribed, true);
    assert.equal(subs.list().length, 0);

    const again = await UnsubscribeMcpResourceTool.execute({ uri: 'memo://welcome' }, ctx);
    assert.equal(again.ok, false);
    assert.match(again.error, /No matching subscription/);
  } finally {
    client.stop();
  }
});

test('mcp: a server without the subscribe capability is refused up front', async () => {
  const subs = new McpSubscriptions();
  const client = new McpClient('fake', stdio({ FAKE_MCP_NO_SUBSCRIBE: '1' }));
  const ctx = { mcpClients: new Map([['fake', client]]), mcpSubs: subs };
  try {
    await client.connect();
    const res = await SubscribeMcpResourceTool.execute({ uri: 'memo://welcome' }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.error, /does not support resources\/subscribe/);
    assert.equal(subs.list().length, 0, 'nothing is registered when the server says no');
  } finally {
    client.stop();
  }
});

test('mcp: subscribe needs a server when several are connected', async () => {
  const subs = new McpSubscriptions();
  const a = new McpClient('a', stdio());
  const b = new McpClient('b', stdio());
  const ctx = { mcpClients: new Map([['a', a], ['b', b]]), mcpSubs: subs };
  try {
    const res = await SubscribeMcpResourceTool.execute({ uri: 'memo://welcome' }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.error, /server is required/);
  } finally {
    a.stop();
    b.stop();
  }
});

test('mcpsubs: unsubscribe works by server, by uri and by id', () => {
  const subs = new McpSubscriptions();
  subs.add({ server: 's1', uri: 'a://1', reason: 'r1' });
  subs.add({ server: 's1', uri: 'a://2' });
  subs.add({ server: 's2', uri: 'a://1' });
  assert.equal(subs.list().length, 3);
  assert.equal(subs.find('a://1').length, 2, 'the same uri on two servers is two subscriptions');
  assert.equal(subs.remove({ subscriptionId: 'mcp:s1:a://1' }).length, 1);
  assert.equal(subs.remove({ server: 's1' }).length, 1);
  assert.equal(subs.remove({}).length, 0, 'no dimension, no unsubscribe');
  assert.equal(subs.list().length, 1);
  // idempotent: re-subscribing refreshes the reason instead of duplicating
  subs.add({ server: 's2', uri: 'a://1', reason: 'new reason' });
  assert.equal(subs.list().length, 1);
  assert.equal(subs.find('a://1')[0].reason, 'new reason');
});

// --- notification handling ---------------------------------------------------

test('mcpnotify: classification covers the notifications we act on and the ones we do not', () => {
  assert.deepEqual(classifyMcpNotification('notifications/message', { level: 'error', data: 'boom' }),
    { kind: 'log', level: 'error', text: 'boom' });
  assert.equal(classifyMcpNotification('notifications/message', { data: { a: 1 } }).text, '{"a":1}');
  assert.deepEqual(classifyMcpNotification('notifications/tools/list_changed'),
    { kind: 'list-changed', what: 'tools' });
  assert.deepEqual(classifyMcpNotification('notifications/prompts/list_changed'),
    { kind: 'list-changed', what: 'prompts' });
  assert.deepEqual(classifyMcpNotification('notifications/resources/list_changed'),
    { kind: 'list-changed', what: 'resources' });
  assert.deepEqual(classifyMcpNotification('notifications/resources/updated', { uri: 'x://1' }),
    { kind: 'resource-updated', uri: 'x://1' });
  assert.equal(classifyMcpNotification('notifications/progress').kind, 'ignore');
  assert.match(classifyMcpNotification('notifications/whatever').why, /unknown notification/);
});

test('mcpnotify: log lines are spoken, list changes refresh, unsubscribed updates stay quiet', async () => {
  const printed = [];
  const refreshed = [];
  const toasts = [];
  const subs = new McpSubscriptions();
  // Line mode prints; the TUI toasts. The same input drives both.
  const base = {
    server: 'srv',
    subs,
    print: (t) => printed.push(t),
  };

  await handleMcpNotification({ ...base, method: 'notifications/message', params: { level: 'info', data: 'hi' } });
  assert.deepEqual(printed, ['ⓘ [srv] info: hi']);

  const changed = await handleMcpNotification({ ...base, method: 'notifications/tools/list_changed', params: {}, refresh: async (s) => { refreshed.push(s); } });
  assert.equal(changed.acted, true);
  assert.deepEqual(refreshed, ['srv']);

  const quiet = await handleMcpNotification({ ...base, method: 'notifications/resources/updated', params: { uri: 'memo://x' } });
  assert.equal(quiet.acted, false);
  assert.equal(quiet.why, 'not subscribed');
  assert.equal(printed.length, 1, 'an update nobody asked about prints nothing');

  subs.add({ server: 'srv', uri: 'memo://x', reason: 'watch it' });
  const loud = await handleMcpNotification({ ...base, method: 'notifications/resources/updated', params: { uri: 'memo://x' } });
  assert.equal(loud.acted, true);
  assert.equal(printed[1], 'ⓘ [srv] resource updated: memo://x (watch it)');

  const ignored = await handleMcpNotification({ ...base, method: 'notifications/progress', params: {} });
  assert.equal(ignored.acted, false);

  // list_changed without a refresh handler reports that nothing was done
  const noHandler = await handleMcpNotification({ ...base, method: 'notifications/tools/list_changed', params: {} });
  assert.equal(noHandler.acted, false);
  assert.equal(noHandler.why, 'no refresh handler');

  // In the TUI the same lines go through toasts instead.
  await handleMcpNotification({
    ...base,
    print: null,
    toast: (v, title, m) => toasts.push([v, title, m]),
    method: 'notifications/message',
    params: { level: 'error', data: 'x' },
  });
  assert.deepEqual(toasts[0], ['error', 'MCP', '[srv] error: x']);
});

test('mcpnotify: format is stable for both surfaces', () => {
  assert.equal(formatMcpNotification('a', { kind: 'log', level: 'info', text: 't' }), '[a] info: t');
  assert.equal(formatMcpNotification('a', { kind: 'resource-updated', uri: 'u' }), '[a] resource updated: u');
  assert.equal(formatMcpNotification('a', { kind: 'list-changed', what: 'tools' }), '[a] tools changed');
});

// --- permissions -------------------------------------------------------------

test('permissions: reading MCP resources is read-only (plan mode allows it)', () => {
  const perms = new Permissions('plan');
  assert.equal(perms.decide('ListMcpResources'), 'allow');
  assert.equal(perms.decide('ReadMcpResource', { uri: 'x://1' }), 'allow');
  assert.equal(perms.planReject('ListMcpResources'), null);
  assert.equal(perms.planReject('ReadMcpResource', { uri: 'x://1' }), null);
  // subscriptions change state on the server, so they still need approval
  assert.notEqual(perms.decide('SubscribeMcpResource', { uri: 'x://1' }), 'allow');
  // and the neighbouring read/write pair is untouched
  assert.equal(perms.decide('Read', { file_path: 'a' }), 'allow');
  assert.notEqual(perms.decide('Write', { file_path: 'a' }), 'allow');
});
