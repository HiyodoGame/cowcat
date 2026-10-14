// W3 editor: cursor model and editing keys in LineEditor (insert/move/kill).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LineEditor } from '../src/lineeditor.js';

// --- insert / cursor movement -------------------------------------------------

test('W3: insert at cursor after moveLeft/moveRight keeps buffer correct', () => {
  const ed = new LineEditor({});
  ed.insert('hel');
  assert.equal(ed.text, 'hel');
  assert.equal(ed.cursor, 3);
  ed.moveLeft();
  assert.equal(ed.cursor, 2);
  ed.insert('x');
  assert.equal(ed.text, 'hexl');
  assert.equal(ed.cursor, 3);
  ed.moveRight();
  ed.insert('!');
  assert.equal(ed.text, 'hexl!');
});

test('W3: moveLeft at start and moveRight at end are no-ops', () => {
  const ed = new LineEditor({});
  ed.moveLeft();
  assert.equal(ed.cursor, 0);
  ed.insert('ab');
  ed.moveRight();
  assert.equal(ed.cursor, 2);
  ed.moveRight();
  assert.equal(ed.cursor, 2);
  ed.home();
  assert.equal(ed.cursor, 0);
  ed.home();
  assert.equal(ed.cursor, 0);
  ed.end();
  assert.equal(ed.cursor, 2);
});

test('W3: home/end jump across lines', () => {
  const ed = new LineEditor({});
  ed.insert('ab\ncd');
  ed.end();
  assert.equal(ed.cursor, 5);
  ed.home();
  assert.equal(ed.cursor, 3, 'home goes to start of current line');
  ed.insert('X');
  assert.equal(ed.text, 'ab\nXcd');
});

test('W3: moveLeft/moveRight cross line boundaries on the flat buffer', () => {
  const ed = new LineEditor({});
  ed.insert('ab\ncd');
  ed.home();              // start of line 2 (index 3)
  ed.moveLeft();
  assert.equal(ed.cursor, 2, 'end of line 1');
  ed.moveRight();
  assert.equal(ed.cursor, 3);
});

// --- deleteBack / deleteForward ------------------------------------------------

test('W3: deleteBack removes char before cursor, empty buffer is a no-op', () => {
  const ed = new LineEditor({});
  ed.deleteBack();
  assert.equal(ed.text, '');
  ed.insert('abc');
  ed.moveLeft();
  ed.deleteBack();
  assert.equal(ed.text, 'ac');
  assert.equal(ed.cursor, 1);
  ed.home();
  ed.deleteBack();
  assert.equal(ed.text, 'ac', 'line start: nothing to delete');
});

test('W3: deleteForward removes char under cursor, at end is a no-op', () => {
  const ed = new LineEditor({});
  ed.deleteForward();
  assert.equal(ed.text, '');
  ed.insert('abc');
  ed.home();
  ed.deleteForward();
  assert.equal(ed.text, 'bc');
  assert.equal(ed.cursor, 0);
  ed.end();
  ed.deleteForward();
  assert.equal(ed.text, 'bc');
});

// --- kill keys -------------------------------------------------------------------

test('W3: killWordBack deletes the previous word bounded by non-word chars', () => {
  const ed = new LineEditor({});
  ed.insert('git commit -m');
  ed.killWordBack();
  assert.equal(ed.text, 'git commit -');
  ed.killWordBack();
  assert.equal(ed.text, 'git commit', 'the non-word run before the cursor is removed');
  ed.killWordBack();
  assert.equal(ed.text, 'git ');
  ed.killWordBack();
  assert.equal(ed.text, 'git');
  ed.killWordBack();
  assert.equal(ed.text, '');
  ed.killWordBack();
  assert.equal(ed.text, '', 'empty buffer is a no-op');
});

test('W3: killWordBack mid-word and after punctuation', () => {
  const ed = new LineEditor({});
  ed.insert('foo!bar');
  ed.killWordBack();
  assert.equal(ed.text, 'foo!');
  const ed2 = new LineEditor({});
  ed2.insert('foo.bar.baz');
  ed2.home();
  ed2.moveRight();
  ed2.moveRight();
  ed2.moveRight();
  ed2.moveRight(); // cursor after "foo."
  ed2.killWordBack();
  assert.equal(ed2.text, 'foobar.baz', 'the non-word run right before the cursor goes first');
  ed2.killWordBack();
  assert.equal(ed2.text, 'bar.baz', 'next press kills the word itself');
});

test('W3: killToStart kills to line start, killToEnd kills to line end', () => {
  const ed = new LineEditor({});
  ed.insert('hello world');
  ed.home();
  ed.moveRight();
  ed.moveRight();
  ed.moveRight();
  ed.moveRight();
  ed.moveRight();
  ed.moveRight(); // cursor after "hello "
  ed.killToStart();
  assert.equal(ed.text, 'world');
  assert.equal(ed.cursor, 0);
  ed.killToStart();
  assert.equal(ed.text, 'world', 'at line start: no-op');

  const ed2 = new LineEditor({});
  ed2.insert('hello world');
  ed2.home();
  ed2.moveRight();
  ed2.moveRight();
  ed2.moveRight();
  ed2.moveRight();
  ed2.moveRight(); // cursor after "hello"
  ed2.killToEnd();
  assert.equal(ed2.text, 'hello');
  ed2.killToEnd();
  assert.equal(ed2.text, 'hello', 'at line end: no-op');
});

test('W3: killToStart / killToEnd are line-wise inside a multiline buffer', () => {
  const ed = new LineEditor({});
  ed.insert('ab\ncd');
  ed.home();          // start of "cd"
  ed.moveRight();     // between c and d
  ed.killToStart();
  assert.equal(ed.text, 'ab\nd');
  ed.killToEnd();
  assert.equal(ed.text, 'ab\n', 'kills to end of current line only');
});

// --- render: cursor row/col -------------------------------------------------------

test('W3: render reports lines and cursor row/col', () => {
  const ed = new LineEditor({});
  let r = ed.render(80);
  assert.deepEqual(r.lines, ['']);
  assert.equal(r.cursorRow, 0);
  assert.equal(r.cursorCol, 0);

  ed.insert('hello');
  r = ed.render(80);
  assert.deepEqual(r.lines, ['hello']);
  assert.equal(r.cursorRow, 0);
  assert.equal(r.cursorCol, 5);

  ed.insert('\nab');
  ed.home();
  r = ed.render(80);
  assert.deepEqual(r.lines, ['hello', 'ab']);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 0);
});

test('W3: reset clears buffer and cursor', () => {
  const ed = new LineEditor({});
  ed.insert('abc');
  ed.reset();
  assert.equal(ed.text, '');
  assert.equal(ed.cursor, 0);
});

// --- handle() routes the editing keys ----------------------------------------------

test('W3: handle routes arrows/home/end/delete/ctrl-w/u/k to the cursor model', () => {
  const ed = new LineEditor({});
  ed.handle('foo bar');
  ed.handle('\x1b[D'); // left
  assert.equal(ed.cursor, 6);
  ed.handle('\x1b[D\x1b[C'); // left right: net zero
  assert.equal(ed.cursor, 6);
  ed.handle('\x1b[C'); // right, back to end of line
  ed.handle('\x17'); // ctrl+w
  assert.equal(ed.text, 'foo ');
  ed.handle('\x15'); // ctrl+u
  assert.equal(ed.text, '');
  ed.handle('ab');
  ed.handle('\x1b[H'); // home
  ed.handle('\x1b[3~'); // delete forward
  assert.equal(ed.text, 'b');
  ed.handle('\x1b[F'); // end
  ed.handle('\x0b'); // ctrl+k
  assert.equal(ed.text, 'b');
  ed.handle('\x1b[1~'); // home (other flavor)
  ed.handle('\x1b[4~'); // end
  ed.handle('\x7f'); // backspace
  assert.equal(ed.text, '');
});
