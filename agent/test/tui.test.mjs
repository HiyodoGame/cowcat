// TUI wave: pure renderer tests + degradation guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  visibleLen, truncateAnsi, padLine, wrapText, stripFirstChars,
  ctxBar, renderHeader, renderStatus, createCard, renderCard, SPINNER,
  buildScreen, scrollClamp,
} from '../src/tui/render.js';
import { Screen } from '../src/tui/screen.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('TUI render: visibleLen/truncateAnsi preserve ANSI and respect width', () => {
  const colored = '\x1b[31mhello world\x1b[0m';
  assert.equal(visibleLen(colored), 11);
  const cut = truncateAnsi(colored, 5);
  assert.equal(visibleLen(cut), 5);
  assert.ok(cut.includes('\x1b[31m'), 'sequence kept');
  assert.ok(cut.endsWith('\x1b[0m'), 'reset appended');
  assert.equal(visibleLen(truncateAnsi(colored, 50)), 11, 'short lines untouched');
});

test('TUI render: padLine fills to width; stripFirstChars removes visible chars only', () => {
  const padded = padLine('ab', 5);
  assert.equal(visibleLen(padded), 5);
  const stripped = stripFirstChars('\x1b[32mabcdef\x1b[0m', 2);
  assert.equal(visibleLen(stripped), 4);
  assert.ok(!stripped.includes('ab'));
});

test('TUI render: wrapText wraps long lines and keeps short ones', () => {
  const wrapped = wrapText('one two three four five', 9);
  assert.ok(wrapped.every((l) => visibleLen(l) <= 9));
  assert.equal(wrapped.join(' ').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim(), 'one two three four five');
  assert.deepEqual(wrapText('short', 80), ['short']);
  assert.deepEqual(wrapText('a\nb', 80), ['a', 'b']);
});

test('TUI render: ctxBar thresholds and header layout', () => {
  assert.ok(ctxBar(50).includes('\x1b[32m'));
  assert.ok(ctxBar(75).includes('\x1b[33m'));
  assert.ok(ctxBar(95).includes('\x1b[31m'));
  const h = renderHeader({ bannerLines: [], pct: 42, model: 'kimi', mode: 'default', width: 60 });
  assert.ok(h.length >= 1 && h.length <= 3);
  assert.equal(visibleLen(h[0]), 60);
  assert.ok(h[0].includes('CowCat'), 'plain-text fallback header, no emoji');
  assert.ok(h[0].includes('42%'));
  assert.ok(h[0].includes('kimi [default]'));
});

test('TUI render: status line packs cost/version/cwd at exact width', () => {
  const s = renderStatus({ cost: '$0', version: '0.8.0', cwd: '/repo', mode: 'plan' }, 80);
  assert.equal(visibleLen(s), 80);
  assert.ok(s.includes('cowcat/0.8.0'));
  assert.ok(s.endsWith('/repo'));
});

test('TUI render: card state machine running -> done/error, folded and expanded', () => {
  const card = createCard('tool', '⏺ Bash(echo hi)');
  const running = renderCard(card, { width: 50, spinFrame: 3, colors: false });
  assert.equal(running.length, 1);
  assert.ok(running[0].includes(SPINNER[3]));
  assert.ok(running[0].includes('⏺'), 'tool-card prefix column');

  card.status = 'done';
  card.summaryLines = ['exit 0', 'hello', 'world', 'line4'];
  card.fullLines = ['exit 0', 'hello', 'world', 'line4', 'line5', 'line6'];
  const folded = renderCard(card, { width: 50, colors: false });
  assert.ok(folded[0].includes('⏺'));
  assert.ok(folded.length <= 6, 'folded shows ≤3 body lines + ellipsis + ctrl+o hint');
  assert.ok(folded.some((l) => l.includes('lines) ···')));
  assert.ok(folded.some((l) => l.includes('ctrl+o to expand/collapse')), 'card tail hint');

  card.expanded = true;
  const expanded = renderCard(card, { width: 50, colors: false });
  assert.ok(expanded.some((l) => l.includes('line6')));

  card.status = 'error';
  assert.ok(renderCard(card, { width: 50, colors: false })[0].includes('⏺'));
});

test('TUI render: buildScreen assembles exact height with scroll clamping', () => {
  const transcript = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const screen = buildScreen({
    header: ['H1', 'H2'], transcript, input: ['> x', '─'],
    status: 'STATUS', width: 40, height: 12, scroll: 100,
  });
  assert.equal(screen.length, 12);
  assert.equal(screen[0].trim(), 'H1');
  assert.ok(screen.every((l) => visibleLen(l) === 40), 'every line padded to width');
  assert.equal(screen[11].trim(), 'STATUS');
  // scrolled to bottom: last transcript lines visible above the input box
  assert.ok(screen.some((l) => l.includes('line 59')));
  const clamped = scrollClamp(60, 8, 999);
  assert.equal(clamped, 52);
  assert.equal(scrollClamp(3, 8, 5), 0);
});

test('TUI screen: enter/leave writes alternate-screen sequences', () => {
  const chunks = [];
  const out = { write: (s) => chunks.push(s), columns: 80, rows: 24 };
  const scr = new Screen({ input: { on: () => {}, off: () => {}, once: () => {}, setRawMode: () => {} }, output: out });
  scr.enter();
  scr.draw(['a', 'b']);
  scr.leave();
  const all = chunks.join('');
  assert.ok(all.includes('\x1b[?1049h'), 'alternate screen on');
  assert.ok(all.includes('\x1b[?25l'), 'cursor hidden');
  assert.ok(all.includes('\x1b[?1049l'), 'alternate screen off');
  assert.ok(all.includes('\x1b[?25h'), 'cursor restored');
  assert.ok(all.includes('\x1b[H'), 'frame home');
  assert.ok(all.includes('\x1b[1;1Ha'), 'absolute-addressed frame content');
  assert.ok(all.includes('\x1b[2;1Hb'), 'second row absolute address');
  assert.ok(!all.slice(all.indexOf('\x1b[H')).includes('\n'), 'no bare newline inside a frame');
});

test('TUI wiring: bin must start the TUI (regression — missing tui.start() exits instantly on TTY)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(AGENT_ROOT, 'bin', 'cowcat.mjs'), 'utf8');
  assert.match(src, /\btui\.start\(\)/, 'bin/cowcat.mjs must call tui.start() after constructing TuiUI');
});

// --- degradation guarantees (spawn) --------------------------------------------

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
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-tui-'));
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

test('TUI degrade: non-TTY pipes stay linear — no alternate screen codes', async () => {
  const { server, port } = await fakeServer();
  try {
    const res = await runCli([], {
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
      COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    }, '/exit\n');
    assert.equal(res.code, 0);
    assert.ok(!res.out.includes('\x1b[?1049h'), 'piped stdout must never enter the alternate screen');
  } finally {
    server.close();
  }
});

test('TUI degrade: -p and stream-json modes unaffected; COWCAT_TUI=off forces linear', async () => {
  const { server, port } = await fakeServer();
  try {
    const env = {
      COWCAT_PROVIDER: 'anthropic', COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
      COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
    };
    const p1 = await runCli(['-p', 'hi'], env);
    assert.equal(p1.code, 0);
    assert.ok(p1.out.includes('plain-mode-ok'));
    assert.ok(!p1.out.includes('\x1b[?1049h'));
    const p2 = await runCli(['-p', '--output-format', 'stream-json', 'hi'], env);
    assert.equal(p2.code, 0);
    assert.ok(!p2.out.includes('\x1b[?1049h'));
    const p3 = await runCli(['--yolo', 'hi', '--print'], { ...env, COWCAT_TUI: 'off' });
    assert.equal(p3.code, 0);
    assert.ok(!p3.out.includes('\x1b[?1049h'));
  } finally {
    server.close();
  }
});

// --- TuiUI headless integration: dispatcher, approvals, readLine, Esc ---------
import { TuiUI } from '../src/tui/ui.js';
import { PassThrough } from 'node:stream';

function headlessTui() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: false, version: '0.8.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return { tui, input };
}

test('TUI app: approval resolves via y/n/a keys without an active readLine', async () => {
  const { tui, input } = headlessTui();
  const p = tui.approve('Write', '/tmp/x', {});
  setImmediate(() => input.write('a'));
  assert.equal(await p, 'always');
  tui.close();
});

test('TUI app: readLine submit, history recall, multiline via Ctrl+J', async () => {
  const { tui, input } = headlessTui();
  const r1 = tui.ask('cowcat> ');
  setImmediate(() => input.write('first\r'));
  assert.equal(await r1, 'first');
  const r2 = tui.ask('cowcat> ');
  setImmediate(() => input.write('\x1b[A')); // recall "first"
  setImmediate(() => input.write('\r'));
  assert.equal(await r2, 'first', 'up-arrow recalls history');
  const r3 = tui.ask('cowcat> ');
  setImmediate(() => input.write('\x0a')); // Ctrl+J: multiline
  setImmediate(() => input.write('line1\x0aline2\r'));
  assert.equal(await r3, 'line1\nline2');
  tui.close();
});

test('TUI app: ask() prompt text renders inside the input box', () => {
  const { tui } = headlessTui();
  tui.ask('Choose [1-2]: ');
  const box = tui._inputBox();
  assert.ok(box.some((l) => l.includes('Choose [1-2]:')), 'prompt shown as box content while reading');
  tui.close();
});

test('TUI app: Esc interrupts even mid-stream (no readLine active)', async () => {
  const { tui, input } = headlessTui();
  let hits = 0;
  tui.onInterrupt = () => { hits++; };
  input.write('\x1b');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hits, 1);
  tui.close();
});

test('TUI app: tool cards update in place and fold', async () => {
  const { tui } = headlessTui();
  tui.toolCall('Bash', 'node -v');
  const entry = tui.entries[tui.entries.length - 1];
  assert.equal(entry.card.status, 'running');
  tui.toolSuccess();
  assert.equal(entry.card.status, 'done');
  tui.toolError('boom');
  // no active card anymore -> error printed as its own entry path is fine
  tui.close();
  assert.equal(entry.card.status, 'done');
});

// --- regression wave: slash menu, hardware cursor, absolute-addressed redraw ---

const SLASH_COMMANDS = ['/clear', '/exit', '/help', '/output', '/theme'];

function headlessTui2({ completions = null, realScreen = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const chunks = [];
  output.on('data', (d) => chunks.push(d.toString()));
  const tui = new TuiUI({
    input, output, colors: false, version: '0.10.1', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    completions: completions ? () => SLASH_COMMANDS : null,
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  if (!realScreen) tui.screen.draw = () => {};
  tui.start();
  return { tui, input, chunks };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// candidate row helper: the only input-box line that starts with a blank + '/'
const slashRow = (box) => box.find((l) => l.startsWith(' /'));

test('TUI app: slash menu auto-opens on /, filters, Esc dismisses without interrupt', async () => {
  const { tui, input } = headlessTui2({ completions: true });
  let interrupts = 0;
  tui.onInterrupt = () => interrupts++;
  const p = tui.readLine();
  input.write('/');
  await sleep(10);
  let row = slashRow(tui._inputBox());
  assert.ok(row, 'candidate row shown after typing /');
  for (const c of SLASH_COMMANDS) assert.ok(row.includes(c), `menu lists ${c}`);
  assert.ok(!row.includes('1/'), 'no n/m counter on slash menu');

  input.write('th');
  await sleep(10);
  row = slashRow(tui._inputBox());
  assert.ok(row, 'candidate row still shown');
  assert.ok(row.includes('/theme'), 'narrowed to /theme');
  assert.ok(!row.includes('/help'), 'other candidates filtered out');

  input.write('\x1b'); // Esc: dismiss the menu, must NOT interrupt
  await sleep(30);
  assert.equal(interrupts, 0, 'Esc on open menu does not interrupt');
  assert.equal(tui.editor.text, '/th', 'Esc keeps the draft text');
  assert.ok(!slashRow(tui._inputBox()), 'menu dismissed after Esc');

  input.write('e'); // any edit re-opens the menu
  await sleep(10);
  row = slashRow(tui._inputBox());
  assert.ok(row && row.includes('/theme'), 'menu reappears after editing');

  input.write('\t'); // Tab cycling still works on top of the slash menu
  await sleep(10);
  assert.equal(tui.editor.text, '/theme', 'Tab completes the filtered prefix');
  input.write('\r');
  assert.equal(await p, '/theme');
  tui.close();
});

test('TUI app: slash menu hidden while a bare command is exact or has arguments', async () => {
  const { tui, input } = headlessTui2({ completions: true });
  tui.readLine();
  input.write('/clear');
  await sleep(10);
  assert.ok(!slashRow(tui._inputBox()), 'exact command match: no menu');
  input.write(' x');
  await sleep(10);
  assert.ok(!slashRow(tui._inputBox()), 'arguments after the command word: no menu');
  tui.close();
});

test('TUI app: hardware cursor lands on the editing point inside the input box', async () => {
  const { tui, input, chunks } = headlessTui2({ completions: true, realScreen: true });
  const p = tui.readLine();
  chunks.length = 0;
  input.write('/');
  await sleep(10);
  const all = chunks.join('');
  const height = 29; // max(10, output.rows - 1)
  const inputLen = tui._inputBox().length;
  const row = height - inputLen - 1 + 2;      // inputStart + frame top + first body row
  const col = 2 + 1;                          // border '│ ' + 0-based cursor col after '/'
  assert.ok(
    all.includes(`\x1b[${row + 1};${col + 1}H\x1b[?25h`),
    `expected cursor seq at row=${row + 1} col=${col + 1}`,
  );
  input.write('\r');
  await p;
  tui.close();
});

test('TUI screen: absolute addressing, no bare newlines, shrink clears the tail', () => {
  const chunks = [];
  const out = { write: (s) => chunks.push(s), columns: 80, rows: 24 };
  const scr = new Screen({ input: { on: () => {}, off: () => {}, once: () => {}, setRawMode: () => {} }, output: out });
  scr.enter();
  chunks.length = 0;
  scr.draw(['aa', 'bb', 'cc']);
  scr.draw(['aa', 'BX', 'cc']);   // change one row
  scr.draw(['aa', 'BX']);         // shrink: row 3 must be erased
  const all = chunks.join('');
  assert.ok(all.includes('\x1b[2;1H'), 'dirty row addressed absolutely');
  assert.ok(!all.includes('\n'), 'frame writer never emits bare newlines');
  assert.ok(all.includes('\x1b[3;1H\x1b[J'), 'shrink erases the leftover tail');
  scr.draw(['aa', 'BX'], { row: 1, col: 2 });
  assert.ok(chunks.join('').includes('\x1b[2;3H\x1b[?25h'), 'cursor param positions and shows the cursor');
  scr.leave();
});

test('TUI app: submitting a line leaks no bare newline into the alternate screen', async () => {
  const { tui, input, chunks } = headlessTui2({ realScreen: true });
  chunks.length = 0;
  const p = tui.readLine();
  input.write('hi\r');
  await p;
  assert.ok(!chunks.join('').includes('\n'), '_finishRead must not write a bare newline while the screen is active');
  tui.close();
});
