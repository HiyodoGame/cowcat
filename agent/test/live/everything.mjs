// Live check: resources / templates / prompts against the official
// @modelcontextprotocol/server-everything (the reference server that implements
// all of them). Measures what CowCat's client can actually reach.
//
//   npm install --prefix agent/test/live
//   node agent/test/live/everything.mjs
import { createRequire } from 'node:module';
import { McpClient } from '../../src/mcp.js';
import { ListMcpResourcesTool } from '../../src/tools/mcpresources.js';

const require = createRequire(import.meta.url);
const ENTRY = process.env.MCP_LIVE_EVERYTHING_ENTRY
  || require.resolve('@modelcontextprotocol/server-everything/dist/index.js');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const note = (label, extra) => console.log(`NOTE  ${label}${extra ? ` — ${extra}` : ''}`);

// server-everything takes the transport as argv[2] (default stdio)
const client = new McpClient('everything', { command: process.execPath, args: [ENTRY, 'stdio'] });
await client.connect();
console.log(`connected: ${client.tools.length} tool(s)`);

// --- resources (the area this round is about) --------------------------------
const resources = await client.listResources();
check('resources/list over a real server', resources.length > 0, `${resources.length} resource(s)`);
console.log('      ' + resources.slice(0, 4).map((r) => r.uri).join('\n      '));

const raw = await client.transport.request('resources/list', {});
if (raw.nextCursor) note('server paginates resources/list', `nextCursor=${raw.nextCursor}`);
else note('resources/list is not paginated by this server', `${(raw.resources || []).length} on one page`);

const textRes = resources.find((r) => r.mimeType?.startsWith('text/') || r.uri.endsWith('.md')) || resources[0];
const read = await client.readResource(textRes.uri);
check(`resources/read ${textRes.uri}`, !read.isError && read.text.length > 0, `${read.text.length} chars`);

// --- resource templates: now listed, and surfaced by ListMcpResources -------
const templates = await client.listResourceTemplates();
check('resources/templates/list over a real server', templates.length > 0,
  `${templates.length}: ${templates.slice(0, 3).map((t) => t.uriTemplate).join(', ')}`);
const listed = await ListMcpResourcesTool.execute({}, { mcpClients: new Map([['everything', client]]) });
check('ListMcpResources output includes the templates',
  listed.ok && templates.every((t) => listed.output.includes(t.uriTemplate)),
  templates.map((t) => t.uriTemplate).join(', '));

// --- prompts: discovered at connect, fetched with declared arguments --------
const prompts = client.prompts || [];
check('prompts/list runs during connect', prompts.length > 0,
  `${prompts.length}: ${prompts.slice(0, 4).map((p) => p.name).join(', ')}`);

const noArgs = prompts.find((p) => !(p.arguments || []).some((a) => a.required));
const withArgs = prompts.find((p) => (p.arguments || []).length > 0);
if (noArgs) {
  const got = await client.getPrompt(noArgs.name);
  check(`prompts/get ${noArgs.name} (no arguments)`, got.text.length > 0, `${got.text.length} chars`);
} else {
  check('a prompt without required arguments exists', false);
}
if (withArgs) {
  const values = Object.fromEntries((withArgs.arguments || []).map((a) => [a.name, 'live-check']));
  const got = await client.getPrompt(withArgs.name, values);
  check(`prompts/get ${withArgs.name} (${Object.keys(values).join(', ')})`, got.text.length > 0,
    `${got.text.length} chars`);
} else {
  note('server exposes no prompt with arguments', 'argument mapping is covered by the unit tests');
}

// --- still unsupported: server->client channel ------------------------------
check('client never opens the GET SSE stream (no server-initiated messages)',
  typeof client.transport.subscribe !== 'function',
  'POST-only transport: resources/subscribe, logging and list_changed never reach us');

client.stop();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
