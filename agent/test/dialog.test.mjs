// Dialog system: stack push/pop/focus restore, DialogSelect scoring + paging,
// and the TuiUI integrations (command palette, theme picker with rollback,
// permission pills, session list, help panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { DialogStack, dialogWidth, pickDialogSize } from '../src/tui/dialog.js';
import { DialogSelect, fuzzyScore } from '../src/tui/dialog-select.js';
import { TuiUI } from '../src/tui/ui.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// --- dialog stack ------------------------------------------------------------

test('dialog: width tiers and size picking', () => {
  assert.equal(dialogWidth('medium'), 60);
  assert.equal(dialogWidth('large'), 88);
  assert.equal(dialogWidth('xlarge'), 116);
  assert.equal(pickDialogSize(120), 'xlarge');
  assert.equal(pickDialogSize(100), 'large');
  assert.equal(pickDialogSize(62), 'medium');
  assert.equal(pickDialogSize(40), 'medium', 'tiny terminals still get the medium tier (clamped on paint)');
});

test('dialog: stack push/pop, esc-close-top, focus restore, replace, clear', () => {
  const events = [];
  const stack = new DialogStack({ onFocusChange: (focused) => events.push(`focus:${focused}`) });
  stack._captureFocus = () => () => events.push('restored');
  assert.equal(stack.isOpen(), false);

  stack.open({ id: 'a', onClose: () => events.push('close:a') });
  stack.open({ id: 'b', onClose: () => events.push('close:b') });
  assert.equal(stack.depth, 2);
  assert.equal(stack.top.id, 'b');
  assert.deepEqual(events, ['focus:false']);

  const closed = stack.closeTop(); // esc closes the top only
  assert.equal(closed.id, 'b');
  assert.equal(stack.top.id, 'a');
  assert.deepEqual(events, ['focus:false', 'close:b']);

  stack.closeTop(); // last close restores focus
  assert.deepEqual(events, ['focus:false', 'close:b', 'close:a', 'focus:true', 'restored']);
  assert.equal(stack.isOpen(), false);

  // replace: whole stack swaps, previous onClose fire; opening the first
  // dialog of a new stack captures focus again
  events.length = 0;
  stack.open({ id: 'c', onClose: () => events.push('close:c') });
  stack.replace({ id: 'd', onClose: () => events.push('close:d') });
  assert.deepEqual(events, ['focus:false', 'close:c', 'focus:false']);
  assert.equal(stack.top.id, 'd');
  stack.clear();
  assert.deepEqual(events, ['focus:false', 'close:c', 'focus:false', 'close:d', 'focus:true', 'restored']);
});

// --- fuzzy scoring -------------------------------------------------------------

test('dialog-select: fuzzyScore subsequence with title weight doubling', () => {
  assert.equal(fuzzyScore('', 'anything'), 0, 'empty query matches everything');
  assert.equal(fuzzyScore('xyz', 'theme'), -1, 'non-subsequence does not match');
  assert.ok(fuzzyScore('th', 'theme') > fuzzyScore('tm', 'theme'), 'contiguous beats sparse');
  assert.ok(fuzzyScore('th', 'theme') >= 2 * 2 + 3, 'two title chars doubled plus the prefix bonus');
  // group hits add a light bonus on top of an equal title score; the title is
  // the gate — a group-only subsequence cannot rescue a title miss
  const base = fuzzyScore('ab', 'ab');
  assert.equal(fuzzyScore('ab', 'ab', 'ab'), base + 2, 'group subsequence adds +1 per char');
  assert.equal(fuzzyScore('x', 'ab', 'x'), -1, 'title must match; group bonus is not a filter bypass');
});

test('dialog-select: ranking, grouping, and the visible window', () => {
  const items = [
    { title: 'alpha', group: 'g1' },
    { title: 'beta', group: 'g1' },
    { title: 'alps', group: 'g2' },
    ...Array.from({ length: 15 }, (_, i) => ({ title: `filler${i}`, group: 'g3' })),
  ];
  const ds = new DialogSelect({ items, pageSize: 10 });
  assert.equal(ds.filtered.length, 18);
  ds.setQuery('al');
  assert.deepEqual(ds.filtered.map((i) => i.title), ['alpha', 'alps'], 'prefix matches rank first');
  const { start, rows } = ds.window();
  assert.equal(rows.length, 2);

  // paging: PgDn jumps a page, the window follows the selection
  ds.setQuery('');
  ds.move(12);
  const w2 = ds.window();
  assert.ok(w2.start > 0, 'window scrolled so the selection stays visible');
  assert.ok(w2.rows.includes(ds.filtered[12]));

  // group headers render at the first row of each group in view
  const text = ds.rows(60, { colors: false }).map(strip);
  assert.ok(text.includes('  g3'), 'the visible group header renders');
  assert.equal(text.filter((l) => l.trim() === 'g3').length, 1, 'no duplicate headers');
  const small = new DialogSelect({ items: [{ title: 'a', group: 'g1' }, { title: 'b', group: 'g2' }], pageSize: 10 });
  const smallText = small.rows(40, { colors: false }).map(strip);
  assert.ok(smallText.includes('  g1') && smallText.includes('  g2'), 'all groups headed when everything fits');
});

test('dialog-select: cyclic selection, ctrl+p/n, action bar cycling', () => {
  const picked = [];
  const ds = new DialogSelect({
    items: [{ title: 'one' }, { title: 'two' }, { title: 'three' }],
    actions: [{ id: 'run', label: 'run' }, { id: 'kill', label: 'kill' }],
    onPick: (item) => picked.push(item.title),
  });
  ds.handleKey('down');
  assert.equal(ds.selected.title, 'two');
  ds.handleKey('down');
  ds.handleKey('down'); // wraps past the end
  assert.equal(ds.selected.title, 'one', 'selection loops');
  ds.handleKey('up');
  assert.equal(ds.selected.title, 'three', 'up loops backwards');
  ds.handleKey('ctrl+p');
  assert.equal(ds.selected.title, 'two', 'ctrl+p moves up');
  ds.handleKey('ctrl+n');
  assert.equal(ds.selected.title, 'three');

  assert.equal(ds.actionSel, -1, 'focus starts on the list');
  ds.handleKey('tab');
  assert.equal(ds.actionSel, 0);
  ds.handleKey('tab');
  assert.equal(ds.actionSel, 1);
  ds.handleKey('tab'); // past the last action focus returns to the list
  assert.equal(ds.actionSel, -1);
  const bar = strip(ds.actionBar(40, { colors: false })[0]);
  assert.ok(bar.includes('run') && bar.includes('kill'));
  ds.handleKey('enter'); // focused list item confirms
  assert.deepEqual(picked, ['three']);
});

// --- TuiUI integrations -----------------------------------------------------------

function headlessTui(opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, lang: 'en', version: '0.14.0', cwd: '/x',
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

test('dialog: ctrl+p opens the command palette, filtering + enter runs a command', () => {
  const tui = headlessTui();
  tui._handleKey('\x10');
  assert.equal(tui._dialogs.top.id, 'palette');
  // search for the theme command and run it — the theme dialog replaces the stack
  for (const ch of 'theme') tui._handleKey(ch);
  tui._handleKey('\r');
  assert.equal(tui._dialogs.top.id, 'theme', 'palette entry opened the theme picker');
  tui._handleKey('\x1b'); // esc closes (rollback)
  assert.equal(tui._dialogs.isOpen(), false);
  tui.close();
});

test('dialog: theme picker live preview + esc rollback + enter apply', () => {
  const tui = headlessTui();
  assert.equal(tui.themeName, 'dark');
  tui._openThemePicker();
  tui._handleKey('\x1b[B'); // ↓ previews light
  assert.equal(tui.themeName, 'light', 'live preview while browsing');
  tui._handleKey('\x1b'); // esc rolls back
  assert.equal(tui.themeName, 'dark', 'esc reverts to the entry theme');
  tui._openThemePicker();
  tui._handleKey('\x1b[B');
  tui._handleKey('\r'); // enter applies
  assert.equal(tui.themeName, 'light');
  assert.ok(tui._flat().map(strip).some((l) => l.trim() === 'theme: light'));
  assert.equal(tui._dialogs.isOpen(), false);
  tui.close();
});

test('dialog: bare /theme submit is intercepted into the picker', async () => {
  const tui = headlessTui();
  const p = tui.readLine();
  for (const ch of '/theme') tui._handleKey(ch);
  tui._handleKey('\r');
  assert.equal(await p, '', 'the REPL receives an empty (no-op) line');
  assert.equal(tui._dialogs.top.id, 'theme', 'the picker opened instead');
  tui._handleKey('\x1b');
  tui.close();
});

test('dialog: permission prompt pills — cycle, confirm, esc-deny, diff scroll', async () => {
  const tui = headlessTui();
  const { unifiedDiff } = await import('../src/diffcard.js');
  const bigOld = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
  const bigNew = Array.from({ length: 30 }, (_, i) => `line${i} changed`).join('\n');
  const { items, added, removed } = unifiedDiff(bigOld, bigNew);
  const p = tui.approve('Edit', 'update f.js', { preview: { path: 'f.js', isNew: false, items, added, removed } });
  const box = tui._inputBox().map(strip);
  assert.ok(box[0].includes('△ Permission required'), 'prompt replaces the composer');
  assert.ok(box.some((l) => l.includes('Allow once') && l.includes('Allow always') && l.includes('Deny')));
  assert.ok(box.some((l) => /diff preview \(1-6\/\d+\)/.test(l)), 'embedded scrollable diff');

  // h/l cycle the pills (wrap both ways)
  tui._handleKey('l');
  assert.equal(tui._pendingApproval.pillSel, 1);
  tui._handleKey('\x1b[D'); // left arrow
  assert.equal(tui._pendingApproval.pillSel, 0);

  // ↓ scrolls the diff preview instead of the transcript
  tui._handleKey('\x1b[B');
  assert.equal(tui._pendingApproval.scroll, 1);

  // esc denies
  tui._handleKey('\x1b');
  assert.equal(await p, 'n');
  assert.equal(tui._pendingApproval, null);
  tui.close();

  // enter confirms the selected pill (always)
  const t2 = headlessTui();
  const p2 = t2.approve('Write', '/tmp/x', {});
  t2._handleKey('\x1b[C');
  t2._handleKey('\r');
  assert.equal(await p2, 'always');
  t2.close();
});

test('dialog: session list opens (ctrl+g), empty-state entry, esc closes; help panel lists bindings', () => {
  const tui = headlessTui();
  tui._handleKey('\x07');
  assert.equal(tui._dialogs.top.id, 'sessions');
  tui._handleKey('\x1b');
  assert.equal(tui._dialogs.isOpen(), false);

  tui._handleKey('?');
  assert.equal(tui._dialogs.top.id, 'help');
  let rows = strip(tui._dialogs.top.render(80).join('\n'));
  assert.ok(rows.includes('›'), 'search box row');
  assert.ok(rows.includes('modal'), 'bindings grouped by mode');
  for (const ch of 'mode') tui._handleKey(ch); // filter down to mode.switch
  rows = strip(tui._dialogs.top.render(80).join('\n'));
  assert.ok(rows.includes('mode.switch'), 'filtering finds a binding by name');
  tui._handleKey('\x1b');
  tui.close();
});

test('dialog: dialogs paint as a dimmed in-frame overlay', () => {
  const tui = headlessTui();
  let frame = null;
  tui.screen.draw = (lines) => { frame = lines; };
  tui._handleKey('\x10');
  tui._draw();
  assert.ok(frame, 'frame drawn');
  const height = 29;
  const padTop = Math.floor(height / 4);
  assert.ok(strip(frame[padTop]).includes('Command palette'), 'dialog title at height/4');
  assert.ok(frame[0].includes('\x1b[2m'), 'rows outside the dialog band are dimmed');
  assert.ok(frame[padTop].includes(tui.theme.userBubbleBg), 'dialog rows sit on the solid surface');
  tui._handleKey('\x1b');
  tui.close();
});
