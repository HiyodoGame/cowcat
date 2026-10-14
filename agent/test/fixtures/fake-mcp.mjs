#!/usr/bin/env node
// Fake stdio MCP server for tests: initialize / tools/list / tools/call
// / resources/list / resources/read.
const TOOLS = [
  { name: 'echo', description: 'Echo back the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];
const RESOURCES = [
  { uri: 'memo://welcome', name: 'welcome', description: 'Greeting memo', mimeType: 'text/plain' },
  { uri: 'blob://logo', name: 'logo', description: 'Binary blob', mimeType: 'application/octet-stream' },
];
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
      respond(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
    } else if (msg.method === 'tools/list') {
      respond(msg.id, { tools: TOOLS });
    } else if (msg.method === 'resources/list') {
      respond(msg.id, { resources: RESOURCES });
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
function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
