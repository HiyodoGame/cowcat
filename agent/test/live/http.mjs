// Live check: real Streamable HTTP MCP server (official SDK, stateful -> mints
// mcp-session-id, answers in SSE) + a real SDK stdio server with a paginated
// tools/list.
//
//   npm install --prefix agent/test/live
//   node agent/test/live/http.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpClient } from '../../src/mcp.js';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// --- real Streamable HTTP server (stateful: session id + SSE responses) -------
const mcp = new McpServer({ name: 'live-http', version: '1.0.0' });
mcp.registerTool('echo', { description: 'echo back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
mcp.registerTool('boom', { description: 'always errors', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'kaboom' }], isError: true }));

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);

const http = createServer((req, res) => {
  if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    try {
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      console.error('  [server] handler error:', e.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      if (!res.writableEnded) res.end('server error');
    }
  });
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${http.address().port}/mcp`;
console.log('http server:', url);

const httpClient = new McpClient('live-http', { url });
await httpClient.connect();
check('initialize + notifications/initialized + tools/list over real HTTP',
  httpClient.tools.length === 2, `${httpClient.tools.length} tools: ${httpClient.tools.map((t) => t.name).join(', ')}`);

const sid = httpClient.transport.sessionId;
check('mcp-session-id captured from the initialize response', !!sid, sid);

const echo = await httpClient.callTool('echo', { text: 'real http' });
check('tools/call over SSE response', !echo.isError && echo.text === 'echo: real http', JSON.stringify(echo.text));
const boom = await httpClient.callTool('boom', {});
check('isError result survives the SSE path', boom.isError === true, JSON.stringify(boom.text));

// prove the header really is mandatory: the same request without it is rejected
const noSid = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
});
check('server rejects a session-less request (why the header fix matters)', noSid.status === 400, `HTTP ${noSid.status}`);

// and show what the wire actually looked like with the header
const withSid = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
  body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} }),
});
const ctype = withSid.headers.get('content-type');
const sseBody = await withSid.text();
check('responses come back as an SSE stream (multi-line data:)',
  ctype.includes('text/event-stream') && sseBody.includes('data:'), `${ctype}, ${sseBody.split('\n').length} lines`);
check('every data: frame is valid JSON-RPC',
  sseBody.split('\n').filter((l) => l.startsWith('data:')).every((l) => { try { JSON.parse(l.slice(5)); return true; } catch { return false; } }));

httpClient.stop();
await new Promise((r) => http.close(r));

// --- real SDK stdio server with paginated tools/list --------------------------
const paged = new McpClient('paged-sdk', {
  command: process.execPath,
  args: [fileURLToPath(new URL('./paged-server.mjs', import.meta.url)), join(process.cwd())],
});
await paged.connect();
check('tools/list cursor loop against a real paginated server (7 tools / 3 per page)',
  paged.tools.length === 7, `${paged.tools.length} tools: ${paged.tools.map((t) => t.name).join(', ')}`);
const first = await paged.callTool('tool_6', {});
check('a tool from the last page is callable', first.text === 'called tool_6', JSON.stringify(first.text));
paged.stop();
await new Promise((r) => setTimeout(r, 400));
check('paged server reaped', paged.transport.child.exitCode !== null || paged.transport.child.signalCode !== null);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
