// Collapse dual-budget algorithm: line budget, character budget, the
// shell-command 2-line cap, and tail preservation with the (N earlier lines)
// marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collapseToolOutput, collapseCommand, COLLAPSE_LIMITS } from '../src/tui/collapse.js';

test('collapse: content inside both budgets passes through untouched', () => {
  const r = collapseToolOutput('a\nb\nc');
  assert.equal(r.collapsed, false);
  assert.deepEqual(r.lines, ['a', 'b', 'c']);
  assert.equal(r.omittedLines, 0);
  assert.equal(r.omittedChars, 0);
});

test('collapse: line overflow keeps the tail and marks the dropped count', () => {
  const content = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const r = collapseToolOutput(content); // default 5-line budget
  assert.equal(r.collapsed, true);
  assert.equal(r.omittedLines, 15);
  assert.equal(r.lines[0], '(15 earlier lines)');
  assert.deepEqual(r.lines.slice(1), ['l15', 'l16', 'l17', 'l18', 'l19'], 'tail preserved');
  assert.equal(r.lines.length, COLLAPSE_LIMITS.lines + 1);
});

test('collapse: exactly at the line budget is not collapsed', () => {
  const content = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n');
  const r = collapseToolOutput(content);
  assert.equal(r.collapsed, false);
  assert.deepEqual(r.lines, ['l0', 'l1', 'l2', 'l3', 'l4']);
});

test('collapse: character overflow drops whole rows from the top first', () => {
  const rows = ['x'.repeat(600), 'short-a', 'short-b', 'short-c'];
  const r = collapseToolOutput(rows.join('\n'), { maxLines: 10, maxChars: 100 });
  assert.ok(r.collapsed);
  assert.equal(r.omittedLines, 1, 'the oversized head row is dropped whole');
  assert.equal(r.lines[0], '(1 earlier lines)');
  assert.ok(r.lines.slice(1).join('\n').length <= 100);
  assert.equal(r.omittedChars >= 600, true);
});

test('collapse: a single oversized row is hard-cut with an ellipsis', () => {
  const r = collapseToolOutput('x'.repeat(500), { maxLines: 5, maxChars: 100 });
  assert.equal(r.collapsed, true);
  assert.equal(r.omittedLines, 0, 'no row dropped: the head row itself is cut');
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].startsWith('…'));
  assert.ok(r.lines[0].length <= 101);
  assert.equal(r.omittedChars, 400, 'hard-cut reports the removed character count');
});

test('collapse: both budgets combine — line cap first, then the char cap', () => {
  const rows = [...Array.from({ length: 30 }, (_, i) => `r${i}`), 'y'.repeat(900)];
  const r = collapseToolOutput(rows.join('\n'), { maxLines: 5, maxChars: 100 });
  assert.equal(r.omittedLines, 30, 'both budgets drop from the top: 26 line-budget + 4 char-budget rows');
  assert.ok(r.lines.join('\n').length <= 100 + '(30 earlier lines)'.length + 5);
  assert.equal(r.lines.at(-1).startsWith('…'), true, 'the huge tail row is char-cut');
});

test('collapse: shell commands are capped at 2 rows', () => {
  const cmd = ['line one', 'line two', 'line three', 'line four'].join('\n');
  const r = collapseCommand(cmd);
  assert.equal(r.omittedLines, 2);
  assert.deepEqual(r.lines, ['(2 earlier lines)', 'line three', 'line four']);
  assert.equal(COLLAPSE_LIMITS.commandLines, 2);
});

test('collapse: empty and single-line content are safe', () => {
  assert.deepEqual(collapseToolOutput('').lines, ['']);
  assert.deepEqual(collapseToolOutput('only').lines, ['only']);
  assert.deepEqual(collapseToolOutput(null).lines, ['']);
});
