// P3: right sidebar panel, error card-ification, and the approval-card rule
// display. Covers the pure sidebar render fns, the layout width shrink, the
// API-error parser/formatters, and the TUI integration surfaces (bash error
// card, apiError card, approval matched rule + y/a/n keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { TuiUI } from '../src/tui/ui.js';
import { visibleLen } from '../src/tui/render.js';
import { renderSidebar, stitchSidebar, sidebarWidth, SIDEBAR_WIDTH } from '../src/tui/sidebar.js';
import { parseApiError, formatApiErrorLines } from '../src/errfmt.js';

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const tick = () => new Promise((r) => setImmediate(r));

function headlessTui({ columns = 120, rows = 30, overrides = {} } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  const frames = [];
  const tui = new TuiUI({
    input, output, colors: true, version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
    ...overrides,
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = (lines) => { frames.push(lines.map((l) => String(l))); };
  tui.start();
  return { tui, input, frames };
}

// --- sidebar pure render ------------------------------------------------------------

test('sidebar: renderSidebar emits all sections at exactly height x width', () => {
  const data = {
    pct: 42, used: '8,432', max: '200k',
    model: 'kimi-for-coding', effort: 'high', mode: 'default',
    mcp: [{ name: 'filesystem', ok: true }, { name: 'broken', ok: false }],
    todos: [
      { status: 'in_progress', content: 'write the parser' },
      { status: 'completed', content: 'scaffold the CLI' },
    ],
  };
  const lines = renderSidebar(data, SIDEBAR_WIDTH, 30, { colors: true, theme: null, lang: 'zh' });
  assert.equal(lines.length, 30, 'one row per frame row');
  for (const l of lines) assert.equal(visibleLen(l), SIDEBAR_WIDTH, 'every row padded to the panel width');
  const text = lines.map(strip).join('\n');
  assert.ok(text.includes('Context'), 'context header');
  assert.ok(text.includes('42%'), 'usage percent');
  assert.ok(text.includes('8,432 / 200k tok'), 'token usage vs ceiling');
  assert.ok(text.includes('kimi-for-coding'), 'model');
  assert.ok(text.includes('effort: high'), 'effort row');
  assert.ok(text.includes('filesystem') && text.includes('broken'), 'MCP server names');
  assert.ok(text.includes('write the parser') && text.includes('scaffold the CLI'), 'todo contents');
  assert.ok(text.includes('✓'), 'completed todo icon');
});

test('sidebar: sidebarWidth auto-hides on narrow terminals and when toggled off', () => {
  assert.equal(sidebarWidth(false, 120), 0, 'off stays off');
  assert.equal(sidebarWidth(true, 120), SIDEBAR_WIDTH, 'wide terminal gets the panel');
  assert.equal(sidebarWidth(true, 99), 0, 'under ~100 cols auto-hides');
  assert.equal(sidebarWidth(true, 80), 0, 'narrow terminal auto-hides');
});

test('sidebar: stitchSidebar joins main rows, separator, and panel rows', () => {
  const main = ['aaa', 'bbb'];
  const side = ['x', 'y'];
  const out = stitchSidebar(main, side, 3, 1, { colors: false });
  assert.deepEqual(out, ['aaa│x', 'bbb│y']);
});

// --- layout shrink -------------------------------------------------------------------

test('panel: transcript width shrinks when the panel is visible, frame stays full-width', async () => {
  const { tui, input, frames } = headlessTui({ columns: 120 });
  tui.print('hello transcript');
  frames.length = 0;
  assert.equal(tui._contentWidth(), 120, 'single column at rest');
  input.write('\x02'); // ctrl+b
  await tick();
  assert.equal(tui.panelVisible, true, 'ctrl+b toggles the panel on');
  assert.equal(tui._sidebarWidth(), SIDEBAR_WIDTH);
  assert.equal(tui._contentWidth(), 120 - SIDEBAR_WIDTH - 1, 'content width shrinks by panel + separator');
  const last = frames[frames.length - 1];
  assert.ok(last, 'a frame was drawn');
  assert.equal(last.length, 29, 'one row per screen row (rows 30 - 1)');
  for (const row of last) assert.equal(visibleLen(row), 120, 'stitched frame spans the full terminal width');
  const text = last.map(strip).join('\n');
  assert.ok(text.includes('Context'), 'sidebar column visible in the frame');
  assert.ok(text.includes('hello transcript'), 'transcript still rendered');
  input.write('\x02');
  await tick();
  assert.equal(tui.panelVisible, false, 'ctrl+b toggles back off');
  assert.equal(tui._contentWidth(), 120);
  tui.close();
});

test('panel: narrow terminal auto-hides the column even when toggled on', async () => {
  const { tui, input } = headlessTui({ columns: 90 });
  input.write('\x02');
  await tick();
  assert.equal(tui.panelVisible, true, 'toggle state remembered');
  assert.equal(tui._sidebarWidth(), 0, 'but the column yields below 100 cols');
  assert.equal(tui._contentWidth(), 90, 'single-column layout');
  tui.output.columns = 120; // user widens the terminal: panel appears
  assert.equal(tui._sidebarWidth(), SIDEBAR_WIDTH, 'panel appears once the terminal is wide enough');
  tui.close();
});

test('panel: sidebar data assembles from the duck-typed getters', () => {
  const { tui } = headlessTui({
    overrides: {
      getModel: () => 'kimi-for-coding',
      getMessages: () => [{ role: 'user', content: 'hi' }],
      getPermissions: () => ({ mode: 'plan', rules: { allow: [], deny: [], ask: [] } }),
      getTodos: () => [{ status: 'in_progress', content: 'ship P3' }],
      getMcp: () => [{ name: 'fs', ok: true }],
    },
  });
  const d = tui._sidebarData();
  assert.equal(d.model, 'kimi-for-coding');
  assert.equal(d.mode, 'plan');
  assert.ok(d.pct >= 0 && typeof d.used === 'string' && d.max !== '?', 'context usage populated');
  assert.equal(d.todos.length, 1);
  assert.deepEqual(d.mcp, [{ name: 'fs', ok: true }]);
  tui.close();
});

// --- error parsing / formatting --------------------------------------------------------

test('errfmt: JSON error body with unknown-model code parses to summary + hint', () => {
  const err = new Error('HTTP 400: {"error":{"code":"1211","message":"Unknown Model: foo-bar"}}');
  const p = parseApiError(err);
  assert.equal(p.status, 400);
  assert.equal(p.code, '1211');
  assert.match(p.message, /Unknown Model/);
  assert.equal(p.hint, 'unknownModel');
  const { lines } = formatApiErrorLines(p, { lang: 'zh' });
  assert.ok(lines[0].includes('HTTP 400') && lines[0].includes('1211'), 'status + code in the one-liner');
  assert.ok(lines[1].includes('/model'), 'unknown-model hint points at /model');
});

test('errfmt: status-class and network failures map to actionable hints', () => {
  assert.equal(parseApiError(new Error('HTTP 401: unauthorized')).hint, 'auth');
  assert.equal(parseApiError(new Error('HTTP 403: forbidden')).hint, 'auth');
  assert.equal(parseApiError(new Error('HTTP 429: slow down')).hint, 'rateLimit');
  assert.equal(parseApiError(new Error('HTTP 500: boom')).hint, 'server');
  assert.equal(parseApiError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8080')).hint, 'network');
  assert.equal(parseApiError(new Error('plain failure, no body')).hint, null, 'unknown errors get no hint');
  const en = formatApiErrorLines(parseApiError(new Error('HTTP 401: {"error":{"message":"bad key"}}')), { lang: 'en' });
  assert.ok(en.lines[1].includes('API key'), 'en hint text');
});

test('errfmt: trailing junk after the JSON body still parses', () => {
  const p = parseApiError(new Error('HTTP 400: {"error":{"code":"1211","message":"Unknown Model: x"}} tail junk'));
  assert.equal(p.code, '1211');
  assert.equal(p.hint, 'unknownModel');
});

// --- TUI integration: error cards ------------------------------------------------------

test('bash error card: non-zero exit renders a red-tinted card with command, exit code, output tail', () => {
  const { tui } = headlessTui();
  tui.toolCall('Bash', 'npm run build');
  const entry = tui.entries[tui.entries.length - 1];
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\nError: build failed';
  tui.bashResultCard({ model: { allLines: output.split('\n') }, command: 'npm run build', exitCode: 2 });
  assert.equal(entry.card.status, 'error');
  const flat = tui._flat().map(strip);
  const head = flat.find((l) => l.includes('✗ exit 2'));
  assert.ok(head, 'exit-code tag rendered');
  assert.ok(tui._flat().some((l) => strip(l).includes('✗ exit 2') && l.includes(tui.theme.error)), 'exit tag tinted red');
  assert.ok(flat.some((l) => l.includes('Error: build failed')), 'output tail survives the collapse');
  assert.ok(flat.some((l) => l.includes('Ran a command') && l.includes('npm run build')), 'failing command in the title');
  tui.close();
});

test('apiError card: JSON error body becomes a red card with hint; raw body on expand', () => {
  const { tui } = headlessTui();
  tui.apiError(new Error('HTTP 400: {"error":{"code":"1211","message":"Unknown Model: nope"}}'));
  const entry = tui.entries[tui.entries.length - 1];
  assert.equal(entry.kind, 'card');
  assert.equal(entry.card.status, 'error');
  const flat = tui._flat().map(strip);
  assert.ok(flat.some((l) => l.includes('Unknown Model')), 'parsed message visible');
  assert.ok(flat.some((l) => l.includes('/model')), 'actionable hint visible');
  entry.card.expanded = true;
  const expanded = tui._flat().map(strip);
  assert.ok(expanded.some((l) => l.includes('"code":"1211"') || l.includes('HTTP 400')), 'raw detail available on expand');
  tui.close();
});

// --- approval card upgrade ---------------------------------------------------------------

const RULES = {
  allow: [{ tool: 'Bash', pattern: 'npm run test', prefix: false, raw: 'Bash(npm run test)' }],
  deny: [],
  ask: [],
};

test('approval: card and prompt show the matched permission rule; y/a/n keys resolve', async () => {
  const { tui, input } = headlessTui({
    overrides: { getPermissions: () => ({ mode: 'default', rules: RULES }) },
  });
  const p = tui.approve('Bash', 'npm run test', { input: { command: 'npm run test' } });
  await tick();
  const entry = tui.entries[tui.entries.length - 1];
  assert.ok(strip(tui._flat().join('\n')).includes('命中规则: Bash(npm run test)'), 'rule on the transcript card');
  // prompt rows carry the rule too (input area while pending)
  const promptText = tui._permissionPrompt(tui._contentWidth()).map(strip).join('\n');
  assert.ok(promptText.includes('命中规则: Bash(npm run test)'), 'rule in the permission prompt');
  input.write('a'); // always allow
  assert.equal(await p, 'always');
  tui.close();
});

test('approval: no matching rule says so, and y allows once', async () => {
  const { tui, input } = headlessTui({
    overrides: { getPermissions: () => ({ mode: 'default', rules: { allow: [], deny: [], ask: [] } }) },
  });
  const p = tui.approve('Write', '/tmp/x', { input: { file_path: '/tmp/x' } });
  await tick();
  assert.ok(strip(tui._flat().join('\n')).includes('无匹配规则'), 'default-ask note on the card');
  input.write('y');
  assert.equal(await p, 'y');
  tui.close();
});

test('approval: n rejects and the pills still work via arrows + enter', async () => {
  const { tui, input } = headlessTui({
    overrides: { getPermissions: () => ({ mode: 'default', rules: RULES }) },
  });
  const p1 = tui.approve('Bash', 'rm -rf /tmp/y', { input: { command: 'rm -rf /tmp/y' } });
  await tick();
  input.write('n');
  assert.equal(await p1, 'n');
  const p2 = tui.approve('Bash', 'npm run test', { input: { command: 'npm run test' } });
  await tick();
  input.write('\x1b[C\r'); // → once more (always), enter
  assert.equal(await p2, 'always');
  tui.close();
});
