// Live check: Streamable HTTP with SSE keep-alive enabled.
//
// The SDK's keep-alive lives on the *web-standard* transport
// (WebStandardStreamableHTTPServerTransport, option `keepAliveMs`, default 15s)
// and writes `: keepalive\n\n` comment frames on the SSE stream. CowCat's
// HttpTransport buffers the whole body (`await res.text()`) before parsing it,
// so a stream that stays open is the interesting case: does a request still
// resolve promptly, or does it hang until the timeout?
//
//   npm install --prefix agent/test/live
//   node agent/test/live/keepalive.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { McpClient } from '../../src/mcp.js';

const KEEPALIVE_MS = 300;
const CLIENT_TIMEOUT_MS = 3000; // keep the experiment short
process.env.COWCAT_MCP_TIMEOUT = String(CLIENT_TIMEOUT_MS);

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const mcp = new McpServer({ name: 'ka', version: '1.0.0' });
mcp.registerTool('echo', { description: 'echo', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  keepAliveMs: KEEPALIVE_MS,
});
await mcp.connect(transport);

let frames = 0; // keepalive comment frames the client actually received
const http = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const webReq = new Request(`http://127.0.0.1${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const webRes = await transport.handleRequest(webReq);
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
  if (webRes.body) {
    for await (const chunk of webRes.body) {
      const text = Buffer.from(chunk).toString('utf8');
      if (text.includes(': keepalive')) frames++;
      res.write(chunk);
    }
  }
  res.end();
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${http.address().port}/mcp`;
console.log(`server ${url}  keepAliveMs=${KEEPALIVE_MS}  client timeout=${CLIENT_TIMEOUT_MS}ms`);

const timed = async (label, fn) => {
  const t0 = Date.now();
  try {
    const out = await fn();
    return { label, ok: true, ms: Date.now() - t0, out };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - t0, err: e.message };
  }
};

const client = new McpClient('ka', { url });
for (const step of [
  ['initialize (+ notifications/initialized)', () => client.transport.connect()],
  ['tools/list', async () => { client.tools = await client._listAllTools(); return `${client.tools.length} tool(s)`; }],
  ['tools/call', async () => (await client.callTool('echo', { text: 'ka' })).text],
]) {
  const r = await timed(step[0], step[1]);
  const hung = !r.ok && /timed out/i.test(r.err || '');
  check(r.label, r.ok, r.ok ? `${r.ms}ms -> ${r.out}` : `${r.ms}ms -> ${r.err}${hung ? '  [HUNG until timeout]' : ''}`);
}

console.log(`\nkeepalive frames seen by the test server: ${frames}`);

// --- phase 2: a server that keeps the SSE stream open after responding -------
// The spec allows this (the stream may carry further notifications), and any
// proxy that holds connections alive behaves the same way. CowCat's transport
// buffers the whole body before parsing, so this is the case where it can stall.
{
  const hold = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch { /* ignore */ }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })}\n\n`);
      // never end: keep sending comment frames like a keep-alive proxy would
      const t = setInterval(() => { try { res.write(': stream stays open\n\n'); } catch { /* closed */ } }, 250);
      res.on('close', () => clearInterval(t));
    });
  });
  await new Promise((r) => hold.listen(0, '127.0.0.1', r));
  const holdUrl = `http://127.0.0.1:${hold.address().port}/mcp`;
  console.log(`\nphase 2: server ${holdUrl} answers then holds the stream open`);
  const c2 = new McpClient('hold', { url: holdUrl });
  const r = await timed('tools/list against a stream-holding server', () => c2.transport.request('tools/list', {}));
  const hung = !r.ok && /timed out/i.test(r.err || '');
  check('resolves as soon as the matching frame arrives (stream may stay open)',
    r.ok, r.ok ? `${r.ms}ms -> ok` : `${r.ms}ms -> ${r.err}${hung ? '  [HUNG until timeout]' : ''}`);
  c2.stop();
  hold.closeAllConnections?.();
  hold.close();
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
client.stop();
http.closeAllConnections?.();
http.close();
process.exit(failures ? 1 : 0);
