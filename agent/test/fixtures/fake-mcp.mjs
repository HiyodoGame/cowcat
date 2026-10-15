#!/usr/bin/env node
// Fake stdio MCP server for tests: initialize / tools/list / tools/call
// / resources/list / resources/read.
import { writeFileSync } from 'node:fs';

const TOOLS = [
  { name: 'echo', description: 'Echo back the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];
const RESOURCES = [
  { uri: 'memo://welcome', name: 'welcome', description: 'Greeting memo', mimeType: 'text/plain' },
  { uri: 'blob://logo', name: 'logo', description: 'Binary blob', mimeType: 'application/octet-stream' },
];
// Templated (dynamic) resources: not enumerable as URIs, listed separately.
const RESOURCE_TEMPLATES = [
  { uriTemplate: 'memo://note/{id}', name: 'note', description: 'One memo by id', mimeType: 'text/plain' },
];
// Prompts: one takes a required argument, one takes none.
const PROMPTS = [
  {
    name: 'greet',
    description: 'Greet someone',
    arguments: [{ name: 'name', description: 'Who to greet', required: true }],
  },
  { name: 'status', description: 'Report the fake status', arguments: [] },
];
// Env-gated behaviours so one fixture covers the tricky cases:
//   FAKE_MCP_PAGE=<n>        serve tools/list in pages of n with nextCursor
//   FAKE_MCP_IGNORE_SIGTERM  stay alive on SIGTERM (exercises SIGKILL escalation)
//   FAKE_MCP_HANG_INIT       never answer initialize (exercises the connect budget)
//   FAKE_MCP_NO_PROMPTS      answer prompts/list with Method not found (optional capability)
//   FAKE_MCP_PIDFILE=<path>  write our pid there (orphan checks after shutdown)
//   FAKE_MCP_STDERR=<text>   print this to stderr, then exit 9 (startup failure)
const PAGE = Number(process.env.FAKE_MCP_PAGE) || 0;
if (process.env.FAKE_MCP_IGNORE_SIGTERM) process.on('SIGTERM', () => {});
if (process.env.FAKE_MCP_PIDFILE) {
  try { writeFileSync(process.env.FAKE_MCP_PIDFILE, String(process.pid)); } catch { /* best effort */ }
}
if (process.env.FAKE_MCP_STDERR) {
  process.stderr.write(`${process.env.FAKE_MCP_STDERR}\n`);
  process.exit(9);
}
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'notifications/initialized') continue;
    if (msg.method === 'initialize') {
      if (process.env.FAKE_MCP_HANG_INIT) continue; // never answer
      respond(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
    } else if (msg.method === 'tools/list') {
      if (!PAGE) { respond(msg.id, { tools: TOOLS }); continue; }
      const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const slice = TOOLS.slice(start, start + PAGE);
      const next = start + PAGE;
      respond(msg.id, next < TOOLS.length ? { tools: slice, nextCursor: String(next) } : { tools: slice });
    } else if (msg.method === 'resources/list') {
      // FAKE_MCP_PAGE also paginates resources so the client's cursor loop is
      // covered (2 resources -> 2 pages of 1)
      if (!PAGE) { respond(msg.id, { resources: RESOURCES }); continue; }
      const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const slice = RESOURCES.slice(start, start + PAGE);
      const next = start + PAGE;
      respond(msg.id, next < RESOURCES.length
        ? { resources: slice, nextCursor: String(next) }
        : { resources: slice });
    } else if (msg.method === 'resources/templates/list') {
      respond(msg.id, { resourceTemplates: RESOURCE_TEMPLATES });
    } else if (msg.method === 'prompts/list') {
      if (process.env.FAKE_MCP_NO_PROMPTS) {
        respond(msg.id, undefined, { code: -32601, message: 'Method not found' });
      } else {
        respond(msg.id, { prompts: PROMPTS });
      }
    } else if (msg.method === 'prompts/get') {
      if (msg.params.name === 'greet') {
        const name = msg.params.arguments?.name;
        if (!name) {
          respond(msg.id, undefined, { code: -32602, message: 'Missing required argument: name' });
        } else {
          respond(msg.id, {
            description: 'Greet someone',
            messages: [
              { role: 'user', content: { type: 'text', text: `Hello ${name}! Please introduce yourself.` } },
              { role: 'assistant', content: { type: 'text', text: '(greeting goes here)' } },
            ],
          });
        }
      } else if (msg.params.name === 'status') {
        respond(msg.id, { messages: [{ role: 'user', content: { type: 'text', text: 'Report the fake status.' } }] });
      } else {
        respond(msg.id, undefined, { code: -32602, message: `Unknown prompt: ${msg.params.name}` });
      }
    } else if (msg.method === 'resources/read') {
      if (msg.params.uri === 'memo://welcome') {
        respond(msg.id, { contents: [{ uri: msg.params.uri, mimeType: 'text/plain', text: 'hello resource' }] });
      } else if (msg.params.uri === 'blob://logo') {
        respond(msg.id, { contents: [{ uri: msg.params.uri, mimeType: 'application/octet-stream', blob: 'aGVsbG8=' }] });
      } else {
        respond(msg.id, { contents: [{ uri: msg.params.uri, mimeType: 'text/plain', text: 'gone' }], isError: true });
      }
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'echo') {
        respond(msg.id, { content: [{ type: 'text', text: `echo: ${msg.params.arguments?.text}` }] });
      } else if (msg.params.name === 'boom') {
        respond(msg.id, { content: [{ type: 'text', text: 'boom!' }], isError: true });
      } else if (msg.params.name === 'hang') {
        // never respond — exercises the client timeout
      }
    }
  }
});
function respond(id, result, error) {
  const msg = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
