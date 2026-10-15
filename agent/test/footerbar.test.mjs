// Status-bar layout (footerbar.js): width-budget degradation, directory
// abbreviation (incl. Windows drive paths), and the esc double-interrupt
// state machine + animation switch integration in TuiUI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { abbreviateDir, formatCost, formatTokenCount, promptFooterLayout, footerLine } from '../src/tui/footerbar.js';
import { visibleLen } from '../src/tui/render.js';
import { TuiUI } from '../src/tui/ui.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// --- directory abbreviation ----------------------------------------------------

test('footerbar: abbreviateDir collapses paths under home only', () => {
  const home = '/home/cat';
  assert.equal(abbreviateDir('/home/cat', home), '~');
  assert.equal(abbreviateDir('/home/cat/project', home), '~/project');
  assert.equal(abbreviateDir('/home/caturday', home), '/home/caturday', 'prefix boundary respected');
  assert.equal(abbreviateDir('/opt/repo', home), '/opt/repo', 'outside home stays verbatim');
  assert.equal(abbreviateDir('', home), '');
});

test('footerbar: Windows drive paths are not tilde-abbreviated; separators normalize', () => {
  const winHome = 'C:\\Users\\cat';
  assert.equal(abbreviateDir('C:\\Users\\cat\\repo', winHome), '~/repo', 'backslash home collapses');
  assert.equal(abbreviateDir('C:/Users/cat/repo', winHome), '~/repo', 'forward-slash home collapses');
  assert.equal(abbreviateDir('F:/WorkSpace/AIProjects', winHome), 'F:/WorkSpace/AIProjects', 'other drives stay verbatim');
  assert.equal(abbreviateDir('F:\\WorkSpace', 'F:\\WorkSpace'), '~', 'same-drive home collapses');
});

// --- formatting ------------------------------------------------------------------

test('footerbar: cost and token formats never fake data', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(1.5), '$1.50');
  assert.equal(formatCost(''), '', 'unknown cost omits the segment');
  assert.equal(formatCost('abc'), '');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(12345), '12.3k');
  assert.equal(formatTokenCount(NaN), '');
});

// --- promptFooterLayout breakpoints (ported semantics) ------------------------------

test('footerbar: promptFooterLayout keeps usage+shortcuts only within the budget', () => {
  const usage = ['12.3k (12%)'];
  const shortcuts = ['ctrl+p commands'];
  // wide: both fit (available = width - min(28, width/2))
  assert.deepEqual(promptFooterLayout({ width: 80, usage, shortcuts }), { usage: true, shortcuts: true });
  // narrow: usage alone fits the half-width budget, shortcuts dropped
  const narrow = promptFooterLayout({ width: 40, usage, shortcuts });
  assert.equal(narrow.usage, true);
  assert.equal(narrow.shortcuts, false);
  // tiny: nothing fits
  assert.deepEqual(promptFooterLayout({ width: 10, usage, shortcuts }), { usage: false, shortcuts: false });
  // usage-only and shortcuts-only inputs
  assert.deepEqual(promptFooterLayout({ width: 80, usage, shortcuts: [] }), { usage: true, shortcuts: false });
  assert.deepEqual(promptFooterLayout({ width: 80, usage: [], shortcuts }), { usage: false, shortcuts: true });
  assert.deepEqual(promptFooterLayout({ width: 80, usage: [], shortcuts: [] }), { usage: false, shortcuts: false });
});

// --- footerLine segment dropping -----------------------------------------------------

test('footerbar: footerLine drops info segments right-to-left under width pressure', () => {
  const base = { left: '~/repo:main', chips: ['act'], right: '/repo' };
  const info = ['12.3k (12%)', '$0.42', 'shift+tab act/plan · ctrl+p commands'];
  const wide = footerLine({ width: 100, ...base, info });
  assert.equal(wide.dropped.length, 0);
  for (const seg of info) assert.ok(strip(wide.line).includes(seg), `wide row keeps ${seg}`);
  assert.ok(strip(wide.line).trimEnd().endsWith('/repo'), 'right anchor stays right-aligned');

  const mid = footerLine({ width: 48, ...base, info });
  assert.ok(mid.dropped.length > 0, 'narrow row drops something');
  for (const seg of info.slice(0, info.length - mid.dropped.length)) {
    assert.ok(strip(mid.line).includes(seg));
  }
  for (const seg of mid.dropped) assert.ok(!strip(mid.line).includes(seg));
  assert.ok(strip(mid.line).includes('~/repo:main'), 'the core never truncates before info is gone');
  assert.ok(strip(mid.line).trimEnd().endsWith('/repo'));

  const tiny = footerLine({ width: 28, ...base, info });
  assert.equal(visibleLen(tiny.line), 28);
  assert.ok(strip(tiny.line).includes('act'), 'core survives once all info is dropped');
  const min = footerLine({ width: 20, ...base, info });
  assert.equal(visibleLen(min.line), 20);
  assert.ok(strip(min.line).trimEnd().endsWith('/repo'), 'the right anchor never truncates');
});

test('footerbar: footerLine matches the legacy renderStatus shape with no info', () => {
  const chips = ['$0', 'Ask When Needed', 'act', 'kimi'];
  const { line } = footerLine({ width: 60, chips, right: '/repo' });
  const core = ` ${chips.join(' · ')}`;
  const gap = ' '.repeat(Math.max(1, 60 - core.length - '/repo'.length));
  assert.equal(line, `${core}${gap}/repo${' '.repeat(Math.max(0, 60 - core.length - gap.length - 5))}`);
  assert.equal(strip(line).trimEnd().endsWith('/repo'), true);
});

// --- TuiUI integration: status bar / esc state machine / animations -------------------

function headlessTui(opts = {}, rows = 30, columns = 100) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = columns;
  output.rows = rows;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.13.0', cwd: '/home/cat/repo', home: '/home/cat',
    getModel: () => 'kimi', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
    ...opts,
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return tui;
}

test('footerbar: status bar — idle dir left, info right, hints degrade when narrow', () => {
  const tui = headlessTui({ getMessages: () => [{ role: 'user', content: 'hi' }] });
  const s = strip(tui._status());
  assert.ok(s.includes('~/repo'), 'idle left region shows the abbreviated directory');
  assert.ok(!s.includes(':'), 'no branch placeholder leaks while git is unresolved');
  tui._branch = 'main';
  assert.ok(strip(tui._status()).includes('~/repo:main'), 'a resolved branch appends as :branch');
  tui._branch = '-';
  assert.ok(strip(tui._status()).includes('(0%)'), 'context usage segment shows the percentage');
  assert.ok(s.includes('shift+tab') && s.includes('act/plan') && s.includes('ctrl+p') && s.includes('commands'), 'key hints present when wide');
  assert.ok(s.trimStart().startsWith('~/repo'), 'cwd cluster anchors the LEFT (dedup: no second cwd on the right)');
  assert.ok(!s.trimEnd().endsWith('/home/cat/repo'), 'cwd not repeated as the right anchor');
  tui.close();

  const narrow = headlessTui({ getMessages: () => [{ role: 'user', content: 'hi' }] }, 30, 46);
  const ns = strip(narrow._status());
  assert.ok(ns.includes('~/repo'), 'core survives the narrow width');
  assert.ok(!ns.includes('ctrl+p'), 'hints drop first under width pressure');
  narrow.close();
});

test('footerbar: streaming switches the left region to the spinner + esc interrupt', () => {
  const tui = headlessTui();
  tui.userMessage('go');
  tui.streamChunk('working');
  const s = tui._status();
  assert.ok(s.includes('esc interrupt'), 'running footer invites the interrupt key');
  assert.ok(!strip(s).includes('~/repo'), 'idle directory hidden while running');
  assert.ok(tui._timer !== null, 'spinner interval ticks while streaming');
  tui.endStream();
  assert.ok(strip(tui._status()).includes('~/repo'), 'idle directory back after the turn');
  tui.close();
});

test('footerbar: esc double-press interrupt — arm, warning hint, fire, expiry', async () => {
  const tui = headlessTui({ lang: 'en' });
  let hits = 0;
  tui.onInterrupt = () => { hits++; };
  tui._handleKey('\x1b');
  assert.equal(hits, 0, 'first press arms only');
  assert.equal(tui._escArmed, true);
  const armedLine = tui._metadataRow(100);
  assert.ok(armedLine.includes(tui.theme.warning), 'warning-colored hint while armed');
  assert.ok(strip(armedLine).includes('esc again to interrupt'));
  tui._handleKey('\x1b');
  assert.equal(hits, 1, 'second press inside the window fires');
  assert.equal(tui._escArmed, false);
  tui.close();

  // expiry: re-arm with a tiny window, let it lapse, next press re-arms instead of firing
  const t2 = headlessTui();
  let hits2 = 0;
  t2.onInterrupt = () => { hits2++; };
  t2._escArmMs = 25;
  t2._handleKey('\x1b');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t2._escArmed, false, 'the window lapses');
  t2._handleKey('\x1b');
  assert.equal(hits2, 0, 'after expiry the press re-arms, not fires');
  t2._handleKey('\x1b');
  assert.equal(hits2, 1);
  t2.close();
});

test('footerbar: COWCAT_ANIMATIONS=off freezes the spinner and the interval', () => {
  const old = process.env.COWCAT_ANIMATIONS;
  process.env.COWCAT_ANIMATIONS = 'off';
  try {
    const tui = headlessTui();
    assert.equal(tui._animations, false);
    tui.userMessage('go');
    tui.streamChunk('working');
    tui._syncSpinner();
    assert.equal(tui._timer, null, 'no spinner interval when animations are off');
    const f0 = tui.spinFrame;
    tui._tick();
    assert.equal(tui.spinFrame, f0 + 1, 'manual tick still advances the frame counter');
    tui.endStream();
    tui.close();
  } finally {
    if (old === undefined) delete process.env.COWCAT_ANIMATIONS;
    else process.env.COWCAT_ANIMATIONS = old;
  }
});

test('footerbar: startup banner shows vitals and hides on narrow terminals', () => {
  const tui = headlessTui({ getConfig: () => ({ maxContextTokens: 100000, mcpServers: { a: {}, b: {} } }) });
  const line = strip(tui._startupInfo());
  assert.ok(line.includes('CowCat 0.13.0'), 'version');
  assert.ok(line.includes('~/repo'), 'abbreviated cwd');
  assert.ok(line.includes('kimi'), 'model');
  assert.ok(line.includes('2 MCP'), 'MCP server count');
  tui.close();

  const short = headlessTui({}, 13, 100);
  assert.equal(short._startupInfo(), null, 'height < 14 hides the banner');
  short.close();
  const narrowW = headlessTui({}, 30, 43);
  assert.equal(narrowW._startupInfo(), null, 'width < 44 hides the banner');
  narrowW.close();
});
