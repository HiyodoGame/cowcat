// P1 final wave: output styles, statusline, REPL keybindings, structured output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOutputStyles, styleSection } from '../src/outputstyles.js';
import { runStatusLine, statuslinePayload, saveStatusLine } from '../src/statusline.js';
import { LineEditor } from '../src/lineeditor.js';
import { validateSchema, extractJson, writeEvent } from '../src/structured.js';
import { Writable } from 'node:stream';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function setupHome() {
  const saved = process.env.COWCAT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    home,
    restore: () => { if (saved === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = saved; },
  };
}

// --- P1-8 output styles --------------------------------------------------------

test('P1-8: output styles load from both levels, project wins, style section format', () => {
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    mkdirSync(join(home, 'output-styles'), { recursive: true });
    writeFileSync(join(home, 'output-styles', 'concise.md'), `---
description: 先结论后细节
---
回答精炼。先给结论，再给必要细节，不超过 10 行。`);
    mkdirSync(join(cwd, '.cowcat', 'output-styles'), { recursive: true });
    writeFileSync(join(cwd, '.cowcat', 'output-styles', 'concise.md'), `---
description: project concise
---
PROJECT STYLE BODY`);
    writeFileSync(join(cwd, '.cowcat', 'output-styles', 'broken.md'), 'no frontmatter');
    const { styles, warnings } = loadOutputStyles(cwd);
    assert.equal(styles.concise.body, 'PROJECT STYLE BODY', 'project overrides user');
    assert.equal(warnings.length, 1);
    assert.match(styleSection(styles.concise.body), /# Output style[\s\S]*PROJECT STYLE BODY/);
  } finally {
    restore();
  }
});

// --- P1-8 statusline ------------------------------------------------------------

test('P1-8: statusline command receives JSON on stdin and renders first line', async () => {
  const script = process.platform === 'win32'
    ? 'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const j=JSON.parse(d);console.log(j.model+\'@\'+j.ctx_pct)})"'
    : 'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{const j=JSON.parse(d);console.log(j.model+\'@\'+j.ctx_pct)})"';
  const out = await runStatusLine(script, statuslinePayload({ model: 'm1', mode: 'default', ctxPct: 42, cwd: '/x' }));
  assert.equal(out, 'm1@42');
});

test('P1-8: statusline timeout and failure fall back to null silently', async () => {
  const slow = process.platform === 'win32' ? 'ping -n 10 127.0.0.1 >NUL' : 'sleep 10';
  const t0 = Date.now();
  const out = await runStatusLine(slow, statuslinePayload({ model: 'm', mode: 'default', ctxPct: 1, cwd: '/x' }));
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 6000, '2s timeout + kill grace');
  assert.equal(await runStatusLine('exit 1', '{}'), null);
  // A command that exits immediately without reading stdin used to raise EPIPE on
  // the stdin write, which crashed the process on Linux (CI caught it twice:
  // hooks.js and statusline.js). It must simply produce no line.
  const quickExit = process.platform === 'win32' ? 'exit /b 0' : 'exit 0';
  assert.equal(await runStatusLine(quickExit, '{}'), null);
});

test('P1-8: statusline set/clear persists to state.json preserving fields', () => {
  const { home, restore } = setupHome();
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ installId: 'keep' }));
    saveStatusLine('echo hi');
    let onDisk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(onDisk.statusLine.command, 'echo hi');
    assert.equal(onDisk.installId, 'keep');
    saveStatusLine(null);
    onDisk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(onDisk.statusLine, undefined, 'clear restores default');
  } finally {
    restore();
  }
});

// --- P1-9 keybindings ------------------------------------------------------------

test('P1-9: history recall with up/down and edit stash', () => {
  const ed = new LineEditor({});
  ed.handle('first\n')[0]; // submit
  ed.handle('second\n')[0];
  ed.handle('third part')[0]; // in-progress, not submitted
  ed.handle('\x1b[A'); // up -> second
  assert.equal(ed.text, 'second');
  ed.handle('\x1b[A'); // up -> first
  assert.equal(ed.text, 'first');
  ed.handle('\x1b[B'); // down -> second
  assert.equal(ed.text, 'second');
  ed.handle('\x1b[B'); // down -> back to stashed edit
  assert.equal(ed.text, 'third part');
});

test('P1-9: tab cycles slash-command completions; off-command tab inserts spaces', () => {
  const ed = new LineEditor({ completions: () => ['/compact', '/cost', '/clear', '/custom'] });
  ed.handle('/c');
  ed.handle('\t');
  assert.equal(ed.text, '/clear', 'sorted candidates cycle from the first match');
  ed.handle('\t');
  assert.equal(ed.text, '/compact');
  ed.handle('\x7f'.repeat(8)); // wipe "/compact"
  assert.equal(ed.text, '');
  ed.handle('ls');
  ed.handle('\t');
  assert.equal(ed.text, 'ls  ', 'off-command tab = two spaces');
});

test('P1-9: shift-tab emits the mode-switch event', () => {
  const ed = new LineEditor({});
  const events = ed.handle('\x1b[Z');
  assert.deepEqual(events, [{ type: 'shift-tab' }]);
  assert.equal(ed.text, '');
});

// --- P1-10 structured output ------------------------------------------------------

test('P1-10: mini JSON Schema validator covers the supported subset', () => {
  const schema = {
    type: 'object',
    required: ['name', 'tags'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 10 },
      count: { type: 'integer', minimum: 0 },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 },
    },
  };
  assert.equal(validateSchema(schema, { name: 'cow', count: 3, tags: ['a'] }).ok, true);
  const bad = validateSchema(schema, { name: 'x', count: -1, tags: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 3, 'length/minimum/minItems all reported');
  assert.ok(bad.errors.some((e) => e.includes('name')));
  assert.ok(validateSchema({ type: 'object', required: ['x'] }, {}).errors[0].includes('缺必填属性'));
});

test('P1-10: extractJson pulls values from prose and fences', () => {
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('here you go:\n```json\n{"a":[1,2]}\n```\ndone').value, { a: [1, 2] });
  assert.equal(extractJson('no json here').value, null);
});

test('P1-10: writeEvent emits one JSON object per line', () => {
  const chunks = [];
  const out = new Writable({ write(c, e, cb) { chunks.push(c.toString()); cb(); } });
  writeEvent(out, { type: 'system', n: 1 });
  writeEvent(out, { type: 'assistant', delta: 'hi' });
  const lines = chunks.join('').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'system');
  assert.equal(JSON.parse(lines[1]).delta, 'hi');
});

function fakeLLMServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function sseText(res, text) {
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
}

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-p1-'));
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ trustedProjects: [cwd] }));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), ...args], {
      env: { ...process.env, COWCAT_HOME: cwd, ...env },
      cwd,
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('P1-10: --output-format stream-json emits pure NDJSON events, no decorations', async () => {
  const { server, port } = await fakeLLMServer((req, res, body) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
    sseText(res, '{"answer": 42}');
  });
  try {
    const res = await runCli(['-p', '--output-format', 'stream-json', 'give json'], {
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`, COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    });
    assert.equal(res.code, 0, res.err);
    const lines = res.out.trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));
    assert.equal(events[0].type, 'system');
    assert.ok(events.some((e) => e.type === 'assistant' && e.delta));
    assert.equal(events[events.length - 1].type, 'result');
    assert.ok(!/▄▟█/.test(res.out), 'no banner decorations in the stream');
    assert.ok(!/CowCat — provider/.test(res.out), 'no status line in the stream');
  } finally {
    server.close();
  }
});

test('P1-10: --output-schema pass + retry-on-fail path (exit 3 on double fail)', async () => {
  let calls = 0;
  const { server, port } = await fakeLLMServer((req, res, body) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
    calls++;
    // first call answers wrongly, retry answers correctly
    sseText(res, calls === 1 ? 'I think 42' : '{"answer": 42}');
  });
  try {
    const env = { COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`, COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off' };
    const schema = JSON.stringify({ type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } } });
    const res = await runCli(['-p', '--output-schema', schema, 'answer with json'], env);
    assert.equal(res.code, 0, res.err);
    assert.equal(calls, 2, 'validation failure triggered exactly one retry');
    assert.match(res.out, /"answer": 42/);

    let calls2 = 0;
    const env2 = { ...env };
    const { server: s2, port: p2 } = await fakeLLMServer((req, res2, body) => {
      if (req.url.startsWith('/v1/messages/count_tokens')) { res2.end(JSON.stringify({ input_tokens: 1 })); return; }
      calls2++;
      sseText(res2, 'no json ever');
    });
    try {
      const fail = await runCli(['-p', '--output-schema', schema, 'x'], { ...env2, COWCAT_BASE_URL: `http://127.0.0.1:${p2}` });
      assert.equal(fail.code, 3, `expected exit 3, got ${fail.code}`);
      assert.equal(calls2, 2);
    } finally { s2.close(); }
  } finally {
    server.close();
  }
});

test('P1-10: --max-turns overrun exits 4', async () => {
  const { server, port } = await fakeLLMServer((req, res, body) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
    // always answer with a tool call -> loop until the turn cap
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  });
  try {
    const res = await runCli(['-p', '--max-turns', '2', 'loop forever'], {
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`, COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    });
    assert.equal(res.code, 4, `expected exit 4, got ${res.code}: ${res.out.slice(0, 200)}`);
  } finally {
    server.close();
  }
});

test('P1-9 spawn smoke: piped REPL still works and exits (keys silently disabled off-TTY)', async () => {
  const { server, port } = await fakeLLMServer((req, res, body) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
    sseText(res, 'ok');
  });
  try {
    const res = await runCli([], {
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`, COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    }, '/exit\n');
    assert.equal(res.code, 0);
  } finally {
    server.close();
  }
});
