#!/usr/bin/env node
// Fake stdio MCP server for tests: initialize / tools/list / tools/call /
// resources (list/read/templates/subscribe) / prompts, plus server->client
// notifications and requests.
import { writeFileSync, appendFileSync } from 'node:fs';

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
//   FAKE_MCP_LOG=<text>      send notifications/message right after initialized
//   FAKE_MCP_EXTRA_TOOL=<n>  add tool <n> to tools/list AFTER the first call and
//                            announce it with notifications/tools/list_changed
//   FAKE_MCP_SERVER_REQUEST  send a server->client sampling request after
//                            initialized (the client must answer, not hang)
//   FAKE_MCP_SERVER_PING     send a server->client ping request instead
//   FAKE_MCP_CAPTURE=<path>  append every message we receive to this file
//   FAKE_MCP_NO_SUBSCRIBE    do not advertise resources.subscribe
//   FAKE_MCP_UPDATE_ON_SUB   emit notifications/resources/updated after subscribe
//   FAKE_MCP_NO_LOGGING      do not advertise logging (no logging/setLevel sent)
//   FAKE_MCP_LOG_ON_LEVEL    log the chosen level back as a notification
const PAGE = Number(process.env.FAKE_MCP_PAGE) || 0;
// The tool set grows after the first tools/list so tools/list_changed has a
// visible effect (the refreshed list must contain the new tool).
const EXTRA_TOOL = process.env.FAKE_MCP_EXTRA_TOOL || '';
let listedOnce = false;
const CAPTURE = process.env.FAKE_MCP_CAPTURE || '';
function capture(msg) {
  if (!CAPTURE) return;
  try { appendFileSync(CAPTURE, `${JSON.stringify(msg)}\n`); } catch { /* best effort */ }
}
function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}
function serverRequest(id, method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}
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
    capture(msg);
    if (msg.method === 'notifications/initialized') {
      // Server->client traffic starts here: notifications and requests the
      // client never asked for.
      if (process.env.FAKE_MCP_LOG) notify('notifications/message', { level: 'info', data: process.env.FAKE_MCP_LOG });
      if (process.env.FAKE_MCP_SERVER_REQUEST) {
        serverRequest(9001, 'sampling/createMessage', { messages: [], maxTokens: 1 });
      }
      if (process.env.FAKE_MCP_SERVER_PING) serverRequest(9002, 'ping', {});
      continue;
    }
    if (msg.method === 'initialize') {
      if (process.env.FAKE_MCP_HANG_INIT) continue; // never answer
      const resources = process.env.FAKE_MCP_NO_SUBSCRIBE ? {} : { subscribe: true, listChanged: true };
      const logging = process.env.FAKE_MCP_NO_LOGGING ? {} : { logging: {} };
      respond(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources, prompts: {}, ...logging }, serverInfo: { name: 'fake', version: '1.0.0' } });
    } else if (msg.method === 'logging/setLevel') {
      // Advertising `logging` means we answer this request; a client that never
      // asks has no business expecting log messages.
      respond(msg.id, {});
      if (process.env.FAKE_MCP_LOG_ON_LEVEL) {
        notify('notifications/message', { level: 'info', data: `level=${msg.params?.level}` });
      }
    } else if (msg.method === 'tools/list') {
      // The first call returns the base set; later calls (after a refresh) also
      // see the extra tool, and the change is announced once.
      const tools = listedOnce && EXTRA_TOOL
        ? [...TOOLS, { name: EXTRA_TOOL, description: 'added later', inputSchema: { type: 'object', properties: {} } }]
        : TOOLS;
      if (!listedOnce && EXTRA_TOOL) {
        listedOnce = true;
        notify('notifications/tools/list_changed', {});
      }
      if (!PAGE) { respond(msg.id, { tools }); continue; }
      const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const slice = tools.slice(start, start + PAGE);
      const next = start + PAGE;
      respond(msg.id, next < tools.length ? { tools: slice, nextCursor: String(next) } : { tools: slice });
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
    } else if (msg.method === 'resources/subscribe') {
      respond(msg.id, {});
      if (process.env.FAKE_MCP_UPDATE_ON_SUB) {
        notify('notifications/resources/updated', { uri: msg.params?.uri });
      }
    } else if (msg.method === 'resources/unsubscribe') {
      respond(msg.id, {});
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
