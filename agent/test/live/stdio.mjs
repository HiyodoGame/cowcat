// Live check: real third-party MCP server over stdio.
// Server: @modelcontextprotocol/server-filesystem (official)
// Client: CowCat's own src/mcp.js, imported unmodified.
//
//   npm install --prefix agent/test/live
//   node agent/test/live/stdio.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, mcpToolAdapter } from '../../src/mcp.js';

const require = createRequire(import.meta.url);
const ENTRY = process.env.MCP_LIVE_FS_ENTRY
  || require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');

const sandbox = mkdtempSync(join(tmpdir(), 'mcp-live-sandbox-'));
writeFileSync(join(sandbox, 'hello.txt'), 'hi from cowcat\n');
console.log('sandbox:', sandbox);

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// --- exactly as documented: command "npx" (a .cmd shim on Windows) -----------
{
  const c = new McpClient('fs-npx', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', sandbox] });
  try {
    await c.connect();
    check('documented "command": "npx" config launches the real server', c.tools.length >= 14, `${c.tools.length} tools`);
    const hello = await c.callTool('read_text_file', { path: join(sandbox, 'hello.txt') });
    check('...and serves a real tool call through npx', hello.text.includes('hi from cowcat'), JSON.stringify(hello.text).slice(0, 60));
  } catch (e) {
    check('documented "command": "npx" config launches the real server', false, e.message);
  } finally {
    c.stop();
    await new Promise((r) => setTimeout(r, 400));
  }
}

// --- direct node entry: isolates our protocol code from the launch shim -------
const client = new McpClient('filesystem', { command: process.execPath, args: [ENTRY, sandbox] });
const t0 = Date.now();
await client.connect();
check('initialize + tools/list over real stdio', client.tools.length > 0, `${client.tools.length} tools in ${Date.now() - t0}ms`);
console.log('tools:', client.tools.map((t) => t.name).join(', '));

const byName = (frag) => client.tools.find((t) => t.name.includes(frag));
const listTool = byName('list_directory') || byName('list');
const readTool = byName('read_text_file') || byName('read_file');
const writeTool = byName('write_file');
const infoTool = byName('get_file_info') || byName('file_info');

if (listTool) {
  const r = await client.callTool(listTool.name, { path: sandbox });
  check(`tools/call ${listTool.name}`, !r.isError && r.text.includes('hello.txt'), JSON.stringify(r.text).slice(0, 120));
} else {
  check('list tool present', false);
}

if (readTool) {
  const r = await client.callTool(readTool.name, { path: join(sandbox, 'hello.txt') });
  check(`tools/call ${readTool.name}`, r.text.includes('hi from cowcat'), JSON.stringify(r.text).slice(0, 80));
} else {
  check('read tool present', false);
}

if (writeTool) {
  const r = await client.callTool(writeTool.name, { path: join(sandbox, 'written.txt'), content: 'written by cowcat\n' });
  const onDisk = existsSync(join(sandbox, 'written.txt')) && readFileSync(join(sandbox, 'written.txt'), 'utf8').includes('written by cowcat');
  check(`tools/call ${writeTool.name} lands on disk`, !r.isError && onDisk, JSON.stringify(r.text).slice(0, 80));
} else {
  check('write tool present', false);
}

if (infoTool) {
  const r = await client.callTool(infoTool.name, { path: join(sandbox, 'hello.txt') });
  check(`tools/call ${infoTool.name}`, !r.isError, JSON.stringify(r.text).slice(0, 100));
}

// error path: a path outside the allowed roots must come back as an error result
if (readTool) {
  const r = await client.callTool(readTool.name, { path: 'C:/Windows/win.ini' });
  check('out-of-roots read is rejected', r.isError === true, JSON.stringify(r.text).slice(0, 120));
}

// registry adapter shape (what the model actually sees)
if (listTool) {
  const adapter = mcpToolAdapter(client, 'filesystem', listTool);
  const res = await adapter.execute({ path: sandbox });
  check('mcpToolAdapter wraps a real tool', adapter.name.startsWith('mcp__filesystem__'), adapter.name);
  check('adapter.execute maps success to {ok:true,output}', res.ok === true && res.output.includes('hello.txt'));
  const badRes = await mcpToolAdapter(client, 'filesystem', readTool).execute({ path: 'C:/Windows/win.ini' });
  check('adapter.execute maps isError to {ok:false,error}', badRes.ok === false && !!badRes.error);
}

// resources: the filesystem server may not implement them — either way must not hang
try {
  const res = await client.listResources();
  console.log(`NOTE: resources/list supported -> ${res.length} resource(s)`);
} catch (e) {
  console.log(`NOTE: resources/list unsupported (expected for this server) -> ${e.message}`);
}

// shutdown: no orphan process left behind
const child = client.transport.child;
client.stop();
await new Promise((r) => setTimeout(r, 800));
check('stop() reaps the server process', child.exitCode !== null || child.signalCode !== null, `exitCode=${child.exitCode} signal=${child.signalCode}`);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
