// Live check: full CLI path — a project/user MCP config launches a real
// @modelcontextprotocol server, the stub model calls its tool / runs its prompt,
// and the result must show up in the request the CLI sent.
//   phase 1: server-filesystem (npx) -> mcp__filesystem__list_directory
//   phase 2: server-everything (npx) -> /mcp__everything__<prompt>
//
//   npm install --prefix agent/test/live
//   node agent/test/live/cli-e2e.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../../src/mcp.js';

const require = createRequire(import.meta.url);
const AGENT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const sandbox = mkdtempSync(join(tmpdir(), 'cowcat-live-mcp-'));
const MARKER = 'live-e2e-marker.txt';
writeFileSync(join(sandbox, MARKER), 'created by the live e2e check\n');
console.log('sandbox:', sandbox);

const home = mkdtempSync(join(tmpdir(), 'cowcat-live-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'cowcat-live-cwd-'));
mkdirSync(join(cwd, '.cowcat'), { recursive: true });
// exactly the config shape the docs show
writeFileSync(join(cwd, '.cowcat', 'mcp.json'), JSON.stringify({
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', sandbox] },
  },
}, null, 2));
// pre-trust the server AND the working directory (state.json): an untrusted cwd
// locks -p to read-only plan mode, which denies MCP tool calls
writeFileSync(join(home, 'state.json'), JSON.stringify({
  mcpTrusted: ['filesystem'],
  trustedProjects: [cwd],
}));

const bodies = [];
let turn = 0;
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 3 }));
      return;
    }
    bodies.push(body);
    turn++;
    if (turn === 1) {
      sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'm1', name: 'mcp__filesystem__list_directory', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: sandbox }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]);
      return;
    }
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LIVE-CLI-MCP-DONE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const res = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), '-p', '-y', `list the files in ${sandbox}`], {
    cwd,
    env: {
      ...process.env,
      COWCAT_HOME: home,
      COWCAT_PROVIDER: 'anthropic',
      COWCAT_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      COWCAT_API_KEY: 'live-key',
      COWCAT_MODEL: 'fake-model',
      COWCAT_ANIMATION: 'off',
    },
  });
  let out = ''; let err = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cli timed out')); }, 90_000);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});
server.close();

console.log('--- stdout ---\n' + res.out.trim());
if (res.err.trim()) console.log('--- stderr ---\n' + res.err.trim());
console.log('---');

check('CLI exits 0', res.code === 0, `code=${res.code}`);
check('the real server was connected and its tools registered',
  /MCP filesystem: \d+ tool\(s\)/.test(res.out), (res.out.match(/MCP filesystem: .*/) || [''])[0].trim());
check('the stub model called the MCP tool and got a final answer', res.out.includes('LIVE-CLI-MCP-DONE'));
check('two model turns happened (tool_use then answer)', bodies.length === 2, `${bodies.length} request(s)`);
check('the tool result in turn 2 carries the REAL directory listing',
  (bodies[1] || '').includes(MARKER), (bodies[1] || '').includes(MARKER) ? '' : (bodies[1] || '').slice(0, 300));

// --- phase 2: a real server prompt run through our slash command ------------
// server-everything serves prompts as well as tools; the expected text is read
// from the server first, then asserted inside the request the CLI sent, so this
// covers "third-party server -> /mcp__<server>__<prompt> -> model" end to end.
{
  const ENTRY = require.resolve('@modelcontextprotocol/server-everything/dist/index.js');
  const probe = new McpClient('everything', { command: process.execPath, args: [ENTRY, 'stdio'] });
  await probe.connect();
  const prompt = (probe.prompts || []).find((p) => !(p.arguments || []).some((a) => a.required));
  check('server-everything exposes prompts', !!prompt, `${(probe.prompts || []).length} prompt(s)`);
  const expected = prompt ? (await probe.getPrompt(prompt.name)).text : '';
  probe.stop();
  await new Promise((r) => setTimeout(r, 300));

  const home2 = mkdtempSync(join(tmpdir(), 'cowcat-live-home-'));
  const cwd2 = mkdtempSync(join(tmpdir(), 'cowcat-live-cwd-'));
  writeFileSync(join(home2, 'state.json'), JSON.stringify({ mcpTrusted: ['everything'], trustedProjects: [cwd2] }));
  writeFileSync(join(home2, 'mcp.json'), JSON.stringify({
    mcpServers: { everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } },
  }, null, 2));

  const bodies2 = [];
  const sseText = (res, text) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  };
  const server2 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 3 }));
        return;
      }
      bodies2.push(body);
      sseText(res, 'LIVE-PROMPT-DONE');
    });
  });
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));

  const res2 = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs')], {
      cwd: cwd2,
      env: {
        ...process.env, COWCAT_HOME: home2, COWCAT_PROVIDER: 'anthropic',
        COWCAT_BASE_URL: `http://127.0.0.1:${server2.address().port}`, COWCAT_API_KEY: 'live-key',
        COWCAT_MODEL: 'fake-model', COWCAT_ANIMATION: 'off',
      },
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cli timed out')); }, 120_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // "y" trusts the throwaway cwd; /help then lists the discovered prompt
    // commands, and the prompt itself runs as a slash command
    child.stdin.write(`y\n/help\n/mcp__everything__${prompt ? prompt.name : 'simple-prompt'}\n/exit\n`);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  server2.close();

  check('CLI exits 0 (prompt run)', res2.code === 0, `code=${res2.code} ${res2.err.slice(0, 200)}`);
  check('the prompt command was discovered and listed',
    res2.out.includes(`mcp__everything__${prompt ? prompt.name : 'simple-prompt'}`),
    (res2.out.match(/MCP everything: .*/) || ['(no MCP banner)'])[0].trim());
  check('the REAL prompt text reached the model request',
    expected.length > 0 && bodies2.some((b) => b.includes(expected.slice(0, 40))),
    expected ? `expected starts: ${JSON.stringify(expected.slice(0, 40))}` : 'no expected text');
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
