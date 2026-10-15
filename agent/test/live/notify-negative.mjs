// Live check: what the PRE-FIX notifications/initialized behaviour did against
// a real SDK server. The answer is "this server tolerates it" — so the fix is
// spec correctness rather than a practical blocker. Kept as evidence.
//
//   npm install --prefix agent/test/live
//   node agent/test/live/notify-negative.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const mcp = new McpServer({ name: 'neg', version: '1.0.0' });
mcp.registerTool('ping', { description: 'p', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);

const http = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    try { await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined); }
    catch (e) { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end(); console.error('handler:', e.message); }
  });
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${http.address().port}/mcp`;
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const post = async (obj, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(obj) });
  return { status: r.status, sid: r.headers.get('mcp-session-id'), body: await r.text() };
};

const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'neg', version: '1' } } });
const sid = init.sid;
console.log('initialize ->', init.status, 'sid:', sid);

// OLD client behaviour: initialized sent as a REQUEST (carries an id)
const asReq = await post({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized', params: {} }, { 'mcp-session-id': sid });
console.log('initialized-as-request ->', asReq.status, JSON.stringify(asReq.body).slice(0, 160));

const thenList = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'mcp-session-id': sid });
const servedBeforeNotify = thenList.body.includes('"ping"');
console.log('tools/list before the notification ->', thenList.status, 'served tools:', servedBeforeNotify);

// NEW client behaviour: a real notification (no id)
const asNote = await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, { 'mcp-session-id': sid });
console.log('initialized-as-notification ->', asNote.status, JSON.stringify(asNote.body).slice(0, 80));

const list2 = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { 'mcp-session-id': sid });
const served = list2.body.includes('"ping"');
console.log('tools/list after the notification ->', list2.status, 'served tools:', served);
console.log(servedBeforeNotify
  ? '\nRESULT: this server tolerates the request form (fix #3 is spec correctness, not a blocker)'
  : '\nRESULT: the server refused requests until a proper initialized NOTIFICATION arrived (fix #3 unblocks it)');
process.exit(served ? 0 : 1);
