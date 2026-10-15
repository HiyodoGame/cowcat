// Live check: the MCP server->client channel against the official SDK server.
//
// A real Streamable HTTP server (WebStandardStreamableHTTPServerTransport) that
// offers a GET SSE stream. Verifies, end to end:
//   - the GET stream is opened with the session id
//   - logging/setLevel is requested and logging notifications then arrive
//   - resources/subscribe works and resources/updated arrives
//   - registering a tool after connect raises tools/list_changed, and refresh()
//     picks the new tool up
//   - a dropped stream is re-opened by the client
//
//   npm install --prefix agent/test/live
//   node agent/test/live/stream-channel.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../../src/mcp.js';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const note = (label, extra) => console.log(`NOTE  ${label}${extra ? ` — ${extra}` : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timed out after ${ms}ms`);
    await wait(50);
  }
};

// --- the server --------------------------------------------------------------
// McpServer merges these with the capabilities it derives from registrations.
const mcp = new McpServer({ name: 'live-channel', version: '1.0.0' }, {
  capabilities: { logging: {}, resources: { subscribe: true } },
});
mcp.registerTool('ping_tool', { description: 'ping', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'pong' }] }));
mcp.registerResource('welcome', 'memo://welcome', { description: 'A memo', mimeType: 'text/plain' },
  async () => ({ contents: [{ uri: 'memo://welcome', mimeType: 'text/plain', text: 'live memo' }] }));

// The SDK does not implement subscription bookkeeping: the server author does.
const subscriptions = new Set();
mcp.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  subscriptions.add(req.params.uri);
  return {};
});
mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  subscriptions.delete(req.params.uri);
  return {};
});

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  // Minimal EventStore (the shape the SDK documents): with one configured the
  // server stamps `id:` on every SSE event, which is what makes a reconnect
  // resumable instead of lossy.
  eventStore: {
    events: new Map(),
    async storeEvent(streamId, message) {
      const id = `${streamId}_${this.events.size + 1}`;
      this.events.set(id, message);
      return id;
    },
    async replayEventsAfter(lastEventId, { send }) {
      if (!lastEventId) return '';
      const ids = [...this.events.keys()];
      const at = ids.indexOf(lastEventId);
      if (at === -1) return ids[0] || '';
      for (const id of ids.slice(at + 1)) await send(id, this.events.get(id));
      return ids[0];
    },
  },
});
await mcp.connect(transport);

const gets = []; // every GET request we received, with its headers
let liveGet = null; // the response object of the currently open stream
const http = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.method === 'GET') { gets.push({ headers: req.headers }); liveGet = res; }
  const webReq = new Request(`http://127.0.0.1${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const webRes = await transport.handleRequest(webReq);
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
  if (webRes.body) {
    for await (const chunk of webRes.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
  }
  res.end();
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${http.address().port}/mcp`;
console.log(`server ${url}`);

// --- the client --------------------------------------------------------------
const notes = [];
const errors = [];
const client = new McpClient('live', { url });
client.onNotification = (method, params) => notes.push({ method, params });
client.onChannelError = (e) => errors.push(e.message);

await client.connect();
client.startChannel();
await waitFor(() => gets.length >= 1);

check('GET stream opened with the session id',
  !!gets[0].headers['mcp-session-id'], `accept=${gets[0].headers.accept}`);
check('the client asked for a log level (servers may stay silent without it)',
  (await client.setLogLevel()) === true);

// 1. logging over the real stream
await mcp.server.sendLoggingMessage({ level: 'info', data: 'live logging works' });
await waitFor(() => notes.some((n) => n.method === 'notifications/message'));
const logNote = notes.find((n) => n.method === 'notifications/message');
check('logging notification arrives over the GET stream',
  logNote?.params?.data === 'live logging works', JSON.stringify(logNote?.params?.data));

// 2. resource subscription
await client.subscribe('memo://welcome');
check('resources/subscribe reached the server', subscriptions.has('memo://welcome'));
await mcp.server.sendResourceUpdated({ uri: 'memo://welcome' });
await waitFor(() => notes.some((n) => n.method === 'notifications/resources/updated'));
check('resources/updated arrives for the subscribed resource',
  notes.some((n) => n.params?.uri === 'memo://welcome'));

// 3. tools/list_changed + refresh
mcp.registerTool('late_tool', { description: 'registered after connect', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'late' }] }));
await waitFor(() => notes.some((n) => n.method === 'notifications/tools/list_changed'));
check('registering a tool raises tools/list_changed', true);
await client.refresh();
check('refresh() sees the tool that was added after connect',
  client.tools.some((t) => t.name === 'late_tool'), client.tools.map((t) => t.name).join(', '));

// 4. a dropped stream is re-opened, and what we missed is replayed
const before = gets.length;
liveGet?.destroy(); // kill the connection from the server side
await wait(100); // let the server notice the dead stream
await mcp.server.sendLoggingMessage({ level: 'info', data: 'missed while disconnected' });
await waitFor(() => gets.length > before);
check('the client re-opens the stream after a drop', gets.length > before, `${gets.length} GET(s)`);
const resumed = gets[gets.length - 1].headers['last-event-id'];
check('the re-opened stream carries Last-Event-ID', !!resumed, `last-event-id=${resumed || '(none)'}`);
await waitFor(() => notes.some((n) => n.params?.data === 'missed while disconnected'), 8000);
check('the server replayed the notification sent while we were disconnected', true);

// 5. stop() ends the channel
client.stop();
const after = gets.length;
await wait(300);
check('stop() ends the channel for good', gets.length === after, `${gets.length} GET(s)`);

console.log(`\nnotifications seen: ${notes.map((n) => n.method).join(', ')}`);
if (errors.length) note('channel errors', errors.join('; '));
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
http.closeAllConnections?.();
http.close();
process.exit(failures ? 1 : 0);
