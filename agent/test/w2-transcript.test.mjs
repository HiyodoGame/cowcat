// W2 transcript wiring: entry kinds (user/assistant/text/card), user bubbles,
// tool-card state visuals, turn footer, raw print path, duck-interface parity,
// and non-TTY degradation (spawn e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import { TuiUI } from '../src/tui/ui.js';
import { UI, MockUI } from '../src/ui.js';
import { visibleLen } from '../src/tui/render.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// dark-256 theme tokens (getTheme('dark', '256'))
const BUBBLE_BG = '\x1b[48;5;237m';  // userBubbleBg (background SGR)
const DIM = '\x1b[38;5;246m';        // inactive — running cards
const GREEN = '\x1b[38;5;78m';       // success
const RED = '\x1b[38;5;204m';        // error

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function headless() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.9.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return { tui, input };
}

test('transcript: userMessage renders a userBubbleBg bubble under a subtle › prefix', () => {
  const { tui } = headless();
  tui.userMessage('你好');
  tui.print('after');
  const raw = tui._flat();
  const flat = raw.map(strip);
  const idx = raw.findIndex((l) => l.includes(BUBBLE_BG));
  assert.ok(idx >= 0, 'bubble background SGR present');
  assert.ok(flat[idx].startsWith('› '), 'first bubble line starts with the › prefix');
  assert.ok(flat.slice(idx + 1).some((l) => l.trim() === 'after'), 'following entry unaffected');
});

test('transcript: CJK user bubble wraps with continuations aligned to the text column', () => {
  const { tui } = headless();
  tui.userMessage('你'.repeat(60)); // 120 cols > inner width 94
  const raw = tui._flat();
  const bubble = raw.filter((l) => l.includes(BUBBLE_BG));
  assert.ok(bubble.length > 1, 'long CJK input wraps to multiple bubble lines');
  const text = bubble.map(strip);
  assert.ok(text[0].startsWith('› '));
  assert.ok(text.slice(1).every((l) => l.startsWith('  ')), 'continuations align under the text');
  assert.ok(bubble.every((l) => visibleLen(l) === 96), 'every bubble line is exactly width-4 (no CJK ghost columns)');
});

test('transcript: streamChunk renders markdown bold spans; endStream pushes a ✻ for Ns footer', () => {
  const { tui } = headless();
  tui.userMessage('hi');
  tui.streamChunk('**bold**');
  tui.endStream();
  const raw = tui._flat();
  assert.ok(raw.some((l) => l.includes('\x1b[1m') && strip(l).includes('bold')), 'bold span rendered');
  assert.ok(raw.some((l) => /✻ for \d+s/.test(strip(l))), 'dim turn footer with elapsed seconds');
});

test('transcript: incremental chunks replace the open tail without duplicating rows', () => {
  const { tui } = headless();
  tui.streamChunk('**bo');
  tui.streamChunk('ld** and more');
  const flat = tui._flat().map(strip).map((l) => l.trim());
  assert.equal(flat.filter((l) => l === 'bold and more').length, 1, 'tail rows replaced, not appended');
  const asst = tui.entries.find((e) => e.kind === 'assistant');
  assert.ok(asst, 'assistant entry kind');
});

// Closed rows are emitted once and kept; only the open tail is replaced.
const texts = (tui) => tui._flat().map(strip).map((l) => l.trim());

test('transcript: heading closed by blank line survives the next chunk (closed rows kept)', () => {
  const { tui } = headless();
  tui.streamChunk('## Hi\n\n');
  tui.streamChunk('Body text');
  const flat = texts(tui);
  assert.ok(flat.includes('Hi'), 'closed heading row still present after later push');
  assert.ok(flat.includes('Body text'), 'new tail rendered');
  assert.equal(flat.filter((l) => l === 'Hi').length, 1, 'heading not duplicated');
});

test('transcript: multiple paragraphs accumulate across pushes', () => {
  const { tui } = headless();
  tui.streamChunk('Para one\n\nPara two\n\n');
  tui.streamChunk('Para three');
  const flat = texts(tui);
  for (const p of ['Para one', 'Para two', 'Para three']) {
    assert.ok(flat.includes(p), `${p} present`);
    assert.equal(flat.filter((l) => l === p).length, 1, `${p} exactly once`);
  }
});

test('transcript: plain fast path keeps completed lines when a later chunk arrives', () => {
  const { tui } = headless();
  tui.streamChunk('Hello world\n');
  tui.streamChunk('again');
  const flat = texts(tui);
  assert.ok(flat.includes('Hello world'), 'fast-path completed line kept after next push');
  assert.ok(flat.includes('again'), 'continuation rendered');
  assert.equal(flat.filter((l) => l === 'Hello world').length, 1, 'completed line not duplicated');
});

test('transcript: fast->full switch keeps already-emitted plain lines', () => {
  const { tui } = headless();
  tui.streamChunk('hello\n');
  tui.streamChunk('# T\n');
  const flat = texts(tui);
  assert.ok(flat.includes('hello'), 'plain line survives the switch to full parsing');
  assert.ok(flat.includes('T'), 'heading rendered after switch');
});

test('transcript: opener paragraph then heading — fast→full supersedes closed rows, nothing lost', () => {
  const { tui } = headless();
  tui.streamChunk('Sure, here you go.\n\n');
  tui.streamChunk('# Steps\n\n1. one\n');
  const flat = texts(tui);
  for (const want of ['Sure, here you go.', 'Steps', '1. one']) {
    assert.ok(flat.includes(want), `${want} present`);
    assert.equal(flat.filter((l) => l === want).length, 1, `${want} exactly once`);
  }
});

test('transcript: capabilities wiring — 24bit caps drive the palette, osc8 reaches the markdown renderer', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.9.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '24bit', altScreen: true, osc8: true },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  assert.equal(tui.theme.brand, '\x1b[38;2;215;119;87m', 'theme parsed at the 24bit level');
  tui.streamChunk('**b** [click](http://x)\n');
  const raw = tui._flat().join('\n');
  assert.ok(raw.includes('\x1b]8;;http://x\x1b\\'), 'OSC8 hyperlink emitted when caps.osc8');
  tui.setTheme('light');
  assert.equal(tui.theme.brand, '\x1b[38;2;215;119;87m', 'setTheme keeps the detected level');
  tui.close();
});

test('transcript: capabilities wiring — 16/none caps floor the palette at the 16-color level', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.9.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: 'none', altScreen: false, osc8: false },
  });
  assert.equal(tui.theme.userBubbleBg, '\x1b[100m', "'none' maps to the 16-color level");
  tui.close();
});

test('transcript: fenced block closed by ``` survives subsequent streaming', () => {
  const { tui } = headless();
  tui.streamChunk('```js\nconst x=1\n```\n');
  tui.streamChunk('done');
  const flat = texts(tui);
  assert.ok(flat.includes('const x=1'), 'highlighted fence body kept');
  assert.ok(flat.includes('done'), 'post-fence tail rendered');
  assert.equal(flat.filter((l) => l === 'const x=1').length, 1, 'fence rows not duplicated');
});

test('transcript: tool card states tint the ⏺ prefix column (dim/green/red) with a ctrl+o hint', () => {
  const { tui } = headless();
  tui.toolCall('Bash', 'node -v');
  let line = tui._flat().find((l) => strip(l).includes('⏺'));
  assert.ok(line.includes(DIM), 'running = dim');
  assert.ok(strip(line).startsWith('⏺ '), '⏺ prefix column padded to minWidth 2');
  const entry = tui.entries[tui.entries.length - 1];
  tui.toolSuccess();
  entry.card.summaryLines = ['l1', 'l2', 'l3'];
  entry.card.fullLines = ['l1', 'l2', 'l3', 'l4'];
  tui._invalidateEntry(entry);
  const flat1 = tui._flat();
  line = flat1.find((l) => strip(l).includes('⏺'));
  assert.ok(line.includes(GREEN), 'success = green');
  assert.ok(flat1.some((l) => strip(l).includes('ctrl+o to expand/collapse')), 'card tail hint');
  tui.toolCall('Bash', 'bad');
  tui.toolError('boom');
  line = tui._flat().find((l) => strip(l).includes('⏺') && strip(l).includes('bad'));
  assert.ok(line.includes(RED), 'error = red');
});

test('transcript: ctrl+o toggles the most recent tool card expanded (three key forms)', async () => {
  const { tui, input } = headless();
  tui.toolCall('Bash', 'node -v');
  const entry = tui.entries[tui.entries.length - 1];
  entry.card.status = 'done';
  entry.card.summaryLines = ['l1', 'l2', 'l3'];
  entry.card.fullLines = ['l1', 'l2', 'l3', 'l4', 'l5'];
  tui._invalidateEntry(entry);
  const tick = () => new Promise((r) => setTimeout(r, 10));
  input.write('\x1b[15;5~');
  await tick();
  assert.equal(entry.card.expanded, true, 'F3-style sequence expands');
  assert.ok(tui._flat().some((l) => strip(l).includes('l5')), 'expanded body visible');
  input.write('\x1bOj');
  await tick();
  assert.equal(entry.card.expanded, false, 'SS3 sequence collapses');
  input.write('\x0f');
  await tick();
  assert.equal(entry.card.expanded, true, 'bare Ctrl-O (^O) expands');
});

test('transcript: print() keeps preformatted content on the raw path (no markdown restyling)', () => {
  const { tui } = headless();
  tui.print('|a|b|');
  tui.print('**not-bold**');
  const flat = tui._flat().map(strip).map((l) => l.trim());
  assert.ok(flat.includes('|a|b|'), 'pipe table row verbatim (a markdown table would pad cells)');
  assert.ok(flat.includes('**not-bold**'), 'pre-styled content untouched');
});

test('transcript: line-mode UI and MockUI expose userMessage as a no-op (duck parity)', () => {
  let written = 0;
  const ui = new UI({ output: { write: () => { written++; } }, colors: false });
  ui.userMessage('hello');
  assert.equal(written, 0, 'line-mode userMessage writes nothing');
  const mock = new MockUI({});
  mock.userMessage('hello');
  assert.equal(mock.printed.length, 0, 'MockUI userMessage records nothing');
});

// --- degradation guarantee (spawn e2e) -----------------------------------------

function fakeServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const ev of [
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'plain-mode-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-w2-'));
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ trustedProjects: [cwd] }));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), ...args], {
      env: { ...process.env, COWCAT_HOME: cwd, ...env },
      cwd,
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, 25000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('transcript degrade: fake-SSE conversation over pipes stays linear — no alt screen', async () => {
  const { server, port } = await fakeServer();
  try {
    const res = await runCli([], {
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
      COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    }, 'hi\n/exit\n');
    assert.equal(res.code, 0);
    assert.ok(res.out.includes('plain-mode-ok'), 'one full conversation turn completed');
    assert.ok(!res.out.includes('\x1b[?1049h'), 'piped stdout must never enter the alternate screen');
  } finally {
    server.close();
  }
});

function toolCallServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
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
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('transcript degrade: tool-call turn over pipes carries no escape sequences at all', async () => {
  const { server, port } = await toolCallServer();
  try {
    const res = await runCli(['-p', '--max-turns', '2', 'read a file'], {
      NO_COLOR: '1',
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
      COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    });
    assert.equal(res.code, 4, 'max-turns overrun against the always-tool fake');
    assert.ok(res.out.includes('⏺'), 'tool-call line-mode output present (tool path exercised)');
    assert.ok(!res.out.includes('\x1b'), 'piped stdout must contain no escape sequences whatsoever');
  } finally {
    server.close();
  }
});
