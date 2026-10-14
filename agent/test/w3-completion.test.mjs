// W3 completion wiring: TuiUI drives LineEditor tab cycling through injected
// completions/fileCompletions, renders the candidate row under the input box,
// and Esc cancels candidates instead of interrupting. Plus the pure
// slashCommandList() registry test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { TuiUI } from '../src/tui/ui.js';
import { slashCommandList } from '../src/slashlist.js';

function headlessTui(opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: false, version: '0.8.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
    ...opts,
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return tui;
}

const SLASH = ['/theme', '/thinking', '/status'];
const FILES = ['@README.md', '@render.js'];
const fakeFiles = (prefix) => FILES.filter((f) => f.slice(1).toLowerCase().includes(String(prefix).toLowerCase()));

function type(tui, s) { for (const ch of s) tui._handleKey(ch); }

// --- slash completion via TuiUI --------------------------------------------------

test('W3 completion: Tab replaces /th with first candidate, candidate row shows', () => {
  const tui = headlessTui({ completions: () => SLASH, fileCompletions: fakeFiles });
  tui.readLine();
  type(tui, '/th');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/theme', 'Tab completes to the first matching candidate');
  const row = tui._inputBox().filter((l) => l.includes('/theme') && l.includes('/thinking'));
  assert.ok(row.length, 'candidate row rendered under the input box');
  assert.ok(row[0].includes('1/2'), 'candidate row carries the position counter');
  tui._finishRead(tui.editor.text);
  tui.close();
});

test('W3 completion: consecutive Tab cycles candidates and restores the raw prefix', () => {
  const tui = headlessTui({ completions: () => SLASH, fileCompletions: fakeFiles });
  tui.readLine();
  type(tui, '/th');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/theme');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/thinking', 'second Tab advances to the next candidate');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/th', 'last slot restores the raw prefix');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/theme', 'cycling wraps around');
  tui._finishRead(tui.editor.text);
  tui.close();
});

test('W3 completion: @ prefix goes through fileCompletions', () => {
  const tui = headlessTui({ completions: () => SLASH, fileCompletions: fakeFiles });
  tui.readLine();
  type(tui, '@RE');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '@README.md', '@-mention completes via fileCompletions');
  const row = tui._inputBox().filter((l) => l.includes('@README.md'));
  assert.ok(row.length, 'file candidate row rendered');
  tui._finishRead(tui.editor.text);
  tui.close();
});

test('W3 completion: Esc cancels candidates without firing onInterrupt', () => {
  const tui = headlessTui({ completions: () => SLASH, fileCompletions: fakeFiles });
  let hits = 0;
  tui.onInterrupt = () => { hits++; };
  tui.readLine();
  type(tui, '/th');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/theme');
  tui._handleKey('\x1b');
  assert.equal(hits, 0, 'Esc with active candidates does not interrupt');
  assert.equal(tui.editor.tabBase, null, 'candidate state cleared');
  assert.equal(tui.editor.text, '/theme', 'completed text is kept');
  assert.ok(!tui._inputBox().some((l) => l.includes('1/3')), 'candidate row gone');
  tui._handleKey('\x1b');
  assert.equal(hits, 1, 'Esc without candidates falls through to interrupt');
  tui._finishRead(null);
  tui.close();
});

test('W3 completion: typing after cycling invalidates the candidate state', () => {
  const tui = headlessTui({ completions: () => SLASH, fileCompletions: fakeFiles });
  tui.readLine();
  type(tui, '/th');
  tui._handleKey('\t');
  type(tui, 'x');
  assert.equal(tui.editor.tabBase, null, 'insert resets tab cycling');
  assert.ok(!tui._inputBox().some((l) => l.includes('1/3')), 'candidate row gone after edit');
  tui._finishRead(null);
  tui.close();
});

test('W3 completion: without callbacks Tab is inert on slash input', () => {
  const tui = headlessTui();
  tui.readLine();
  type(tui, '/th');
  tui._handleKey('\t');
  assert.equal(tui.editor.text, '/th', 'no candidates -> text untouched');
  assert.ok(!tui._inputBox().some((l) => l.includes('/theme')), 'no candidate row');
  tui._finishRead(null);
  tui.close();
});

test('W3 completion: Tab with no candidates resets tabBase so the next Esc interrupts', () => {
  const tui = headlessTui({ completions: () => SLASH, fileCompletions: fakeFiles });
  let hits = 0;
  tui.onInterrupt = () => { hits++; };
  tui.readLine();
  type(tui, '/zz');
  tui._handleKey('\t');
  assert.equal(tui.editor.tabBase, null, 'no-match Tab leaves no candidate state behind');
  tui._handleKey('\x1b');
  assert.equal(hits, 1, 'Esc after a no-match Tab falls through to interrupt');
  tui._finishRead(null);
  tui.close();
});

// --- slashCommandList registry ------------------------------------------------------

test('W3 completion: slashCommandList is a clean static registry of built-ins', () => {
  const list = slashCommandList();
  assert.ok(Array.isArray(list) && list.length >= 25, 'covers the full dispatch chain');
  for (const c of list) {
    assert.match(c, /^\/[a-z][a-z-]*$/, `well-formed command name: ${c}`);
  }
  assert.equal(new Set(list).size, list.length, 'no duplicates');
  for (const must of ['/theme', '/compact', '/status', '/exit', '/help', '/init', '/mcp', '/rewind']) {
    assert.ok(list.includes(must), `includes ${must}`);
  }
});
