// ComposerEditor (TUI multiline composer): newline insertion, word movement,
// line-wise kills across rows, cursor mapping, history (in-memory + persisted
// fallback), and the tab-cycle contract shared with the legacy LineEditor.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposerEditor } from '../src/tui/editor.js';

test('editor: enter submits, ctrl+j and shift+enter insert newlines', () => {
  const ed = new ComposerEditor({});
  ed.handle('hello');
  let ev = ed.handle('\x0a'); // ctrl+j: newline, not submit
  assert.equal(ed.text, 'hello\n');
  assert.ok(!ev.some((e) => e.type === 'submit'));
  ed.handle('world');
  ev = ed.handle('\x1b[13;2u'); // shift+enter
  assert.equal(ed.text, 'hello\nworld\n');
  ev = ed.handle('\r'); // enter submits the whole buffer
  assert.equal(ev[0].type, 'submit');
  assert.equal(ev[0].line, 'hello\nworld\n');
  assert.equal(ed.text, '', 'buffer cleared after submit');
});

test('editor: newline insertion lands at the cursor, not the end', () => {
  const ed = new ComposerEditor({});
  ed.handle('one two');
  ed.handle('\x01'); // ctrl+a: line start
  ed.handle('\x0a');
  assert.equal(ed.text, '\none two');
  assert.equal(ed.cursor, 1);
});

test('editor: pasted multi-line text inserts literally (no submit)', () => {
  const ed = new ComposerEditor({});
  const ev = ed.handle('pre');
  ed.insert('line1\nline2\nline3'); // bracketed-paste path feeds one literal chunk
  assert.equal(ed.text, 'preline1\nline2\nline3');
  assert.ok(!ev.some((e) => e.type === 'submit'));
  const r = ed.render(80);
  assert.equal(r.lines.length, 3);
});

// --- word movement ------------------------------------------------------------

test('editor: alt+f/ctrl+right jump to the end of the next word', () => {
  const ed = new ComposerEditor({});
  ed.handle('git commit -m msg');
  ed.handle('\x01');
  ed.handle('\x1bf'); // alt+f
  assert.equal(ed.cursor, 3, 'end of "git"');
  ed.handle('\x1b[1;5C'); // ctrl+right
  assert.equal(ed.cursor, 10, 'end of "commit"');
  ed.handle('\x1bf');
  assert.equal(ed.cursor, 13, 'separator run collapsed onto the next word "m"');
  ed.handle('\x1bf');
  assert.equal(ed.cursor, 17, 'end of "msg"');
  ed.handle('\x1bf');
  assert.equal(ed.cursor, 17, 'buffer end is a no-op');
});

test('editor: alt+b/ctrl+left jump to the start of the previous word', () => {
  const ed = new ComposerEditor({});
  ed.handle('foo bar baz');
  ed.handle('\x1bb'); // alt+b at end
  assert.equal(ed.cursor, 8, 'start of "baz"');
  ed.handle('\x1b[1;5D'); // ctrl+left
  assert.equal(ed.cursor, 4, 'start of "bar"');
  ed.handle('\x1bb');
  assert.equal(ed.cursor, 0, 'start of "foo"');
  ed.handle('\x1bb');
  assert.equal(ed.cursor, 0, 'buffer start is a no-op');
});

test('editor: word movement works across newlines', () => {
  const ed = new ComposerEditor({});
  ed.handle('ab\ncd ef');
  ed.handle('\x1bb');
  assert.equal(ed.cursor, 6, 'start of "ef"');
  ed.handle('\x1bb');
  assert.equal(ed.cursor, 3, 'start of "cd" across the newline');
});

// --- line-wise editing across rows ---------------------------------------------

test('editor: home/end and kills are line-wise inside a multiline buffer', () => {
  const ed = new ComposerEditor({});
  ed.handle('ab\ncd ef');
  ed.handle('\x01'); // start of line 2
  ed.handle('\x05'); // end of line 2
  assert.equal(ed.cursor, 8);
  ed.handle('\x17'); // ctrl+w: kill word back
  assert.equal(ed.text, 'ab\ncd ');
  assert.equal(ed.cursor, 6);
  ed.handle('\x0b'); // ctrl+k: kill to line end (already there)
  assert.equal(ed.text, 'ab\ncd ');
  ed.handle('\x01');
  ed.handle('\x0b');
  assert.equal(ed.text, 'ab\n');
  ed.handle('\x15'); // ctrl+u
  assert.equal(ed.text, 'ab\n');
  assert.equal(ed.cursor, 3, 'at line start: no-op');
});

// --- cursor mapping -------------------------------------------------------------

test('editor: render reports cursor row/col in multiline buffers', () => {
  const ed = new ComposerEditor({});
  ed.handle('hello\nworld');
  let r = ed.render(80);
  assert.deepEqual(r.lines, ['hello', 'world']);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 5);
  ed.handle('\x1b[H'); // home
  r = ed.render(80);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 0);
});

// --- history --------------------------------------------------------------------

test('editor: up/down browse in-memory history with a draft stash', () => {
  const ed = new ComposerEditor({});
  ed.history.push('one', 'two');
  ed.handle('draft');
  ed.handle('\x1b[A');
  assert.equal(ed.text, 'two');
  ed.handle('\x1b[A');
  assert.equal(ed.text, 'one');
  ed.handle('\x1b[B');
  assert.equal(ed.text, 'two');
  ed.handle('\x1b[B');
  assert.equal(ed.text, 'draft', 'past the newest item the draft is restored');
});

test('editor: empty in-memory history falls back to the persisted source', () => {
  const ed = new ComposerEditor({ externalHistory: () => ['older prompt', 'newest prompt'] });
  ed.handle('\x1b[A');
  assert.equal(ed.text, 'newest prompt', '↑ recalls the most recent persisted prompt');
  ed.handle('\x1b[A');
  assert.equal(ed.text, 'older prompt');
  ed.handle('\x1b[B');
  assert.equal(ed.text, 'newest prompt');
  ed.handle('\x1b[B');
  assert.equal(ed.text, '', 'walking off the end restores the empty draft');
});

// --- tab-cycle contract (shared with the legacy LineEditor) ----------------------

test('editor: slash tab cycling completes, wraps, and restores the raw prefix', () => {
  const ed = new ComposerEditor({ completions: () => ['/theme', '/thinking'] });
  ed.handle('/th');
  ed.handle('\t');
  assert.equal(ed.text, '/theme');
  ed.handle('\t');
  assert.equal(ed.text, '/thinking');
  ed.handle('\t');
  assert.equal(ed.text, '/th', 'last slot restores the raw prefix');
  ed.handle('\t');
  assert.equal(ed.text, '/theme', 'cycling wraps');
});

test('editor: typing invalidates an active tab cycle', () => {
  const ed = new ComposerEditor({ completions: () => ['/theme'] });
  ed.handle('/th');
  ed.handle('\t');
  assert.equal(ed.tabBase, '/th');
  ed.handle('x');
  assert.equal(ed.tabBase, null, 'insert resets tab cycling');
  assert.equal(ed.tabCandidates.length, 0);
});
