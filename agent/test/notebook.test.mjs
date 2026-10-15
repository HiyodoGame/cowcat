// NotebookEdit (P3-6): notebook parsing/rendering/editing, the tool's contract,
// and its place in the permission + checkpoint wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseNotebook, editNotebook, splitSource, sourceToString,
  detectStyle, serializeNotebook, normalizeCellType,
} from '../src/notebook.js';
import { NotebookEditTool } from '../src/tools/notebookedit.js';
import { ReadTool } from '../src/tools/read.js';
import { Permissions } from '../src/permissions.js';
import { validateRule, matchRule } from '../src/perrules.js';
import { buildWritePreview, FILE_WRITE_TOOLS } from '../src/loop.js';
import { makeNotebookBuffer } from './fixtures/media.mjs';

const NB = makeNotebookBuffer().toString('utf8');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cowcat-nb-'));
}

function writeNb(dir, text, name = 'analysis.ipynb') {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

// --- pure helpers ------------------------------------------------------------

test('source round-trips exactly for the shapes jupyter writes', () => {
  for (const s of ['', 'x', 'a\nb', 'a\nb\n', 'a\n\nb\n']) {
    assert.equal(sourceToString(splitSource(s)), s, `round trip failed for ${JSON.stringify(s)}`);
  }
  assert.deepEqual(splitSource('a\nb\n'), ['a\n', 'b\n']);
  assert.deepEqual(splitSource(''), []);
  assert.equal(sourceToString(['a\n', 'b']), 'a\nb');
});

test('cell types accept the aliases the model is likely to send', () => {
  assert.equal(normalizeCellType('md'), 'markdown');
  assert.equal(normalizeCellType('CODE'), 'code');
  assert.equal(normalizeCellType('raw'), 'raw');
  assert.equal(normalizeCellType('python'), null);
  assert.equal(normalizeCellType(undefined), null);
});

test('style detection keeps CRLF, tabs and the trailing-newline choice', () => {
  const crlf = detectStyle('{\r\n\t"cells": []\r\n}');
  assert.equal(crlf.eol, '\r\n');
  assert.equal(crlf.indent, '\t');
  assert.equal(crlf.trailingNewline, false);
  const lf = detectStyle('{\n  "cells": []\n}\n');
  assert.equal(lf.eol, '\n');
  assert.equal(lf.indent, '  ');
  assert.equal(lf.trailingNewline, true);
});

// --- editing -----------------------------------------------------------------

test('edit: replace swaps the source, keeps outputs, and honours cell_type', () => {
  const r = editNotebook(NB, { cell_index: 1, edit_mode: 'replace', new_source: 'print("bye")' });
  assert.equal(r.ok, true);
  assert.match(r.summary, /replaced cell \[1\] \(code\)/);
  assert.deepEqual(r.nb.cells[1].source, ['print("bye")']);
  assert.equal(r.nb.cells[1].outputs.length, 3, 'running the cell again is the model\'s job, not the edit\'s');

  const toMd = editNotebook(NB, { cell_index: 1, edit_mode: 'replace', new_source: '## Notes', cell_type: 'markdown' });
  assert.equal(toMd.nb.cells[1].cell_type, 'markdown');
  assert.equal('outputs' in toMd.nb.cells[1], false, 'stale outputs are dropped when a cell stops being code');
  assert.equal('execution_count' in toMd.nb.cells[1], false);

  const toCode = editNotebook(toMd.text, { cell_index: 1, edit_mode: 'replace', cell_type: 'code' });
  assert.equal(toCode.nb.cells[1].cell_type, 'code');
  assert.deepEqual(toCode.nb.cells[1].outputs, []);
  assert.equal(toCode.nb.cells[1].execution_count, null);
});

test('edit: insert places a cell at the index and appending past the end works', () => {
  const mid = editNotebook(NB, { cell_index: 1, edit_mode: 'insert', new_source: 'x = 1', cell_type: 'code' });
  assert.equal(mid.ok, true);
  assert.equal(mid.nb.cells.length, 3);
  assert.deepEqual(mid.nb.cells[1].source, ['x = 1']);
  assert.equal(mid.nb.cells[1].cell_type, 'code');
  assert.deepEqual(mid.nb.cells[1].outputs, []);
  assert.equal(typeof mid.nb.cells[1].id, 'string', 'nbformat 4.5+ cells need an id');
  assert.deepEqual(mid.nb.cells[2].source, ['print("hello")'], 'the old cell shifted down');

  const appended = editNotebook(NB, { cell_index: 2, edit_mode: 'insert', new_source: 'tail' });
  assert.equal(appended.nb.cells.length, 3);
  assert.deepEqual(appended.nb.cells[2].source, ['tail']);
  assert.equal(appended.nb.cells[2].cell_type, 'code', 'insert defaults to a code cell');
});

test('edit: delete removes exactly the indexed cell', () => {
  const r = editNotebook(NB, { cell_index: 0, edit_mode: 'delete' });
  assert.equal(r.ok, true);
  assert.equal(r.nb.cells.length, 1);
  assert.deepEqual(r.nb.cells[0].source, ['print("hello")']);
  assert.match(r.summary, /deleted cell \[0\] \(markdown\)/);
});

test('edit: bad input is refused with an actionable message', () => {
  assert.match(editNotebook(NB, { cell_index: 9, edit_mode: 'replace', new_source: 'x' }).error, /out of range \(notebook has 2 cells\)/);
  assert.match(editNotebook(NB, { cell_index: -1 }).error, /out of range/);
  assert.match(editNotebook(NB, { cell_index: 0.5, edit_mode: 'delete' }).error, /must be an integer/);
  assert.match(editNotebook(NB, { cell_index: 0, edit_mode: 'nope' }).error, /edit_mode must be/);
  assert.match(editNotebook(NB, { cell_index: 0, edit_mode: 'replace' }).error, /needs new_source and\/or cell_type/);
  assert.match(editNotebook(NB, { cell_index: 0, edit_mode: 'insert' }).error, /new_source is required/);
  assert.match(editNotebook(NB, { cell_index: 0, edit_mode: 'replace', new_source: 'x', cell_type: 'python' }).error, /cell_type must be/);
  assert.match(editNotebook('{"cells": "nope"}', { cell_index: 0 }).error, /no "cells" array/);
  assert.match(editNotebook('not json', { cell_index: 0 }).error, /not valid JSON/);
});

test('edit: the file keeps its own formatting and stays deep-equal elsewhere', () => {
  const styled = makeNotebookBuffer({ indent: '    ', eol: '\r\n' }).toString('utf8').replace(/\r\n$/, '');
  const r = editNotebook(styled, { cell_index: 1, edit_mode: 'replace', new_source: 'print("bye")' });
  assert.equal(r.ok, true);
  assert.match(r.text, /\r\n/);
  assert.match(r.text, /\r\n    "cells"/, 'the original 4-space indent is preserved');
  assert.equal(r.text.endsWith('\r\n'), false, 'no trailing newline is invented');

  const before = JSON.parse(styled);
  const after = JSON.parse(r.text);
  after.cells[1].source = before.cells[1].source;
  assert.deepEqual(after, before, 'only the target cell changed');

  // and the serializer is faithful on its own
  const parsed = parseNotebook(NB).nb;
  assert.equal(serializeNotebook(parsed, detectStyle(NB)), NB);
});

// --- the tool ----------------------------------------------------------------

test('NotebookEdit: refuses to run before the notebook has been Read', () => {
  const dir = tmp();
  const path = writeNb(dir, NB);
  const ctx = { cwd: dir, readSet: new Set(), config: { model: 'm' } };
  const denied = NotebookEditTool.execute({ notebook_path: path, cell_index: 0, edit_mode: 'delete' }, ctx);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /has not been read yet in this session/);

  ReadTool.execute({ file_path: path }, ctx);
  const allowed = NotebookEditTool.execute({ notebook_path: path, cell_index: 0, edit_mode: 'delete', }, ctx);
  assert.equal(allowed.ok, true);
  assert.match(allowed.output, /Edited .*deleted cell \[0\] \(markdown\)/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).cells.length, 1);
});

test('NotebookEdit: index-shifting edits tell the model to re-Read', () => {
  const dir = tmp();
  const path = writeNb(dir, NB);
  const ctx = { cwd: dir, readSet: new Set([path]), config: { model: 'm' } };
  const inserted = NotebookEditTool.execute({ notebook_path: path, cell_index: 0, edit_mode: 'insert', new_source: '# top' }, ctx);
  assert.match(inserted.output, /indices after the edit point have shifted/);
  const replaced = NotebookEditTool.execute({ notebook_path: path, cell_index: 1, edit_mode: 'replace', new_source: 'pass' }, ctx);
  assert.equal(/shifted/.test(replaced.output), false, 'a replace does not shift anything');
});

test('NotebookEdit: an out-of-range index points the model back at Read', () => {
  const dir = tmp();
  const path = writeNb(dir, NB);
  const ctx = { cwd: dir, readSet: new Set([path]) };
  const res = NotebookEditTool.execute({ notebook_path: path, cell_index: 42, edit_mode: 'delete' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /out of range/);
  assert.match(res.error, /Read the notebook to see the current cell indices/);
});

// --- wiring: permissions, rules, previews ------------------------------------

test('permissions: NotebookEdit asks by default, is auto-accepted with acceptEdits, blocked in plan', () => {
  const input = { notebook_path: 'analysis.ipynb', cell_index: 0, edit_mode: 'delete' };
  assert.equal(new Permissions('default').decide('NotebookEdit', input), 'ask');
  assert.equal(new Permissions('acceptEdits').decide('NotebookEdit', input), 'allow');
  assert.equal(new Permissions('yolo').decide('NotebookEdit', input), 'allow');
  const plan = new Permissions('plan');
  assert.equal(plan.isReadOnly('NotebookEdit'), false);
  assert.match(plan.planReject('NotebookEdit', input), /read-only/);
  // "always" is remembered per notebook, not per call
  const p = new Permissions('default');
  p.approveAlways('NotebookEdit', input);
  assert.equal(p.decide('NotebookEdit', { notebook_path: 'analysis.ipynb', cell_index: 7, edit_mode: 'replace', new_source: 'x' }), 'allow');
  assert.equal(p.decide('NotebookEdit', { notebook_path: 'other.ipynb', cell_index: 0, edit_mode: 'delete' }), 'ask');
});

test('rules: NotebookEdit(path) matches the notebook path, globs included', () => {
  const known = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash'];
  const exact = validateRule('NotebookEdit(analysis.ipynb)', known).rule;
  assert.equal(matchRule(exact, 'NotebookEdit', { notebook_path: 'analysis.ipynb' }), true);
  assert.equal(matchRule(exact, 'NotebookEdit', { notebook_path: 'other.ipynb' }), false);

  const glob = validateRule('NotebookEdit(notebooks/**)', known).rule;
  assert.equal(matchRule(glob, 'NotebookEdit', { notebook_path: 'notebooks/deep/a.ipynb' }), true);
  assert.equal(matchRule(glob, 'NotebookEdit', { notebook_path: 'src/a.ipynb' }), false);
});

test('preview: a NotebookEdit approval card diffs cells, not JSON', () => {
  const dir = tmp();
  const path = writeNb(dir, NB);
  const ctx = { cwd: dir };
  const preview = buildWritePreview('NotebookEdit', { notebook_path: path, cell_index: 1, edit_mode: 'replace', new_source: 'print("bye")' }, ctx);
  assert.equal(preview.path, path);
  assert.equal(preview.isNew, false);
  const removed = preview.items.filter((i) => i.sign === '-').map((i) => i.text).join('\n');
  const added = preview.items.filter((i) => i.sign === '+').map((i) => i.text).join('\n');
  assert.match(removed, /print\("hello"\)/);
  assert.match(added, /print\("bye"\)/);
  assert.equal(JSON.stringify(preview).includes('"cells"'), false, 'the card talks in cells');

  // an edit that cannot apply yields no preview (the tool reports the error)
  assert.equal(buildWritePreview('NotebookEdit', { notebook_path: path, cell_index: 99, edit_mode: 'delete' }, ctx), null);
});

test('wiring: NotebookEdit is a file-write tool (checkpoint + preview + auto-accept)', () => {
  assert.equal(FILE_WRITE_TOOLS.has('NotebookEdit'), true);
  assert.equal(FILE_WRITE_TOOLS.has('Edit'), true);
  assert.equal(FILE_WRITE_TOOLS.has('Read'), false);
});
