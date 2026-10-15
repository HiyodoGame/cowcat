// Live check: resources / templates / prompts against the official
// @modelcontextprotocol/server-everything (the reference server that implements
// all of them). Measures what CowCat's client can actually reach.
//
//   npm install --prefix agent/test/live
//   node agent/test/live/everything.mjs
import { createRequire } from 'node:module';
import { McpClient } from '../../src/mcp.js';

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

// --- resource templates: does our client reach them? -------------------------
const templates = await client.transport.request('resources/templates/list', {}).catch((e) => ({ error: e.message }));
const tmplList = templates.resourceTemplates || [];
note('server exposes resource templates', tmplList.length
  ? `${tmplList.length}: ${tmplList.slice(0, 3).map((t) => t.uriTemplate).join(', ')}`
  : 'none');
// our client has no templates API, so listResources() cannot show them
check('client has no resources/templates/list API (gap is real, not a guess)',
  typeof client.listResourceTemplates !== 'function',
  'listResources() only calls resources/list');

// --- prompts: does our client reach them? -----------------------------------
const prompts = await client.transport.request('prompts/list', {}).catch((e) => ({ error: e.message }));
const promptList = prompts.prompts || [];
note('server exposes prompts', prompts.error ? `error: ${prompts.error}` : `${promptList.length}: ${promptList.slice(0, 3).map((p) => p.name).join(', ')}`);
check('client has no prompts/list + prompts/get API (not implemented, not just unverified)',
  typeof client.listPrompts !== 'function' && typeof client.getPrompt !== 'function');

// --- subscriptions / resumability ------------------------------------------
check('client never opens the GET SSE stream (no server-initiated messages)',
  typeof client.transport.subscribe !== 'function',
  'POST-only transport: resources/subscribe, logging and list_changed never reach us');

client.stop();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
