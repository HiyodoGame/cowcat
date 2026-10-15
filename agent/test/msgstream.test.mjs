// Message-stream rendering aligned with Open Code: tool-card three-state
// (+denied strikethrough), ctrl+o card cycling, assistant turn footer,
// thinking-block summary slot, and the TUI diff gutter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createCard, renderCard } from '../src/tui/render.js';
import { getTheme } from '../src/tui/theme.js';
import { unifiedDiff, renderFileCard } from '../src/diffcard.js';
import { bashCardModel } from '../src/outputcard.js';
import { AssistantRegion } from '../src/tui/region.js';
import { footerLine, retryLine, errorLine, thinkingSummary } from '../src/tui/footer.js';
import { TuiUI } from '../src/tui/ui.js';

const theme = getTheme('dark', '256');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// --- tool card three-state machine + denied ------------------------------------

test('msgstream: done = green ✓, error = red ✗, denied = red ✗ + struck-through title', () => {
  const done = createCard('tool', '● Used Edit');
  done.status = 'done';
  const doneLine = renderCard(done, { width: 60, colors: true, theme })[0];
  assert.ok(strip(doneLine).startsWith('✓ Used Edit'), 'done icon is ✓');
  assert.ok(doneLine.includes(theme.success), 'done icon is green');

  const err = createCard('tool', '● Used Bash');
  err.status = 'error';
  err.summaryLines = ['boom'];
  const errLine = renderCard(err, { width: 60, colors: true, theme })[0];
  assert.ok(strip(errLine).startsWith('✗ Used Bash'), 'error icon is ✗');
  assert.ok(errLine.includes(theme.error), 'error icon is red');

  const denied = createCard('tool', '● Used Write');
  denied.status = 'denied';
  const deniedLine = renderCard(denied, { width: 60, colors: true, theme })[0];
  assert.ok(strip(deniedLine).startsWith('✗ Used Write'), 'denied keeps the ✗ icon');
  assert.ok(deniedLine.includes('\x1b[9m'), 'denied title is struck through (SGR 9)');
  assert.ok(deniedLine.includes('\x1b[29m'), 'strikethrough is closed');
  assert.ok(deniedLine.includes(theme.error), 'denied icon is red');
  // fixed 2-column status prefix: icons align across states
  for (const line of [doneLine, errLine, deniedLine]) {
    assert.equal(strip(line)[1], ' ', 'icon occupies a fixed 2-column prefix');
  }
});

function headlessTui() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.12.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return tui;
}

test('msgstream: rule-denied toolCall resolves straight to the denied card', () => {
  const tui = headlessTui();
  tui.toolCall('Write', '/tmp/x [denied by rule]');
  const entry = tui.entries[tui.entries.length - 1];
  assert.equal(entry.card.status, 'denied', 'no spinning forever for rule denials');
  const raw = tui._flat().find((l) => strip(l).includes('Used Write'));
  assert.ok(raw.includes('\x1b[9m'), 'title struck through');
  tui.close();
});

test('msgstream: user denial marks the pending card denied', () => {
  const tui = headlessTui();
  tui.toolCall('Bash', 'rm -rf wall');
  tui.denied();
  const entry = tui.entries.find((e) => e.kind === 'card');
  assert.equal(entry.card.status, 'denied');
  const raw = tui._flat().find((l) => strip(l).includes('Ran a command'));
  assert.ok(raw.includes('\x1b[9m'), 'denied bash card struck through');
  tui.close();
});

test('msgstream: ctrl+o cycles through foldable cards newest-first then folds all', () => {
  const tui = headlessTui();
  const cards = [];
  for (const name of ['one', 'two', 'three']) {
    tui.toolCall('Bash', name);
    const entry = tui.entries[tui.entries.length - 1];
    entry.card.status = 'done';
    entry.card.summaryLines = ['s'];
    entry.card.fullLines = ['f1', 'f2', 'f3', 'f4'];
    tui._invalidateEntry(entry);
    cards.push(entry);
  }
  const press = () => tui._handleKey('\x0f');
  const expanded = () => cards.filter((c) => c.card.expanded).map((c) => cards.indexOf(c));
  press();
  assert.deepEqual(expanded(), [2], 'first press expands the newest card');
  press();
  assert.deepEqual(expanded(), [1], 'second press moves to the next-older card');
  press();
  assert.deepEqual(expanded(), [0]);
  press();
  assert.deepEqual(expanded(), [], 'past the oldest everything folds');
  press();
  assert.deepEqual(expanded(), [2], 'the cycle wraps');
  tui.close();
});

// --- bash card through the collapse algorithm ------------------------------------

test('msgstream: bash result cards collapse through the dual-budget algorithm', () => {
  const tui = headlessTui();
  tui.toolCall('Bash', 'npm run long');
  const model = bashCardModel(Array.from({ length: 30 }, (_, i) => `out-${i}`).join('\n'));
  assert.equal(model.allLines.length, 30, 'the model carries the full output');
  tui.bashResultCard({ model, command: 'npm run long', exitCode: 0 });
  const entry = tui.entries[tui.entries.length - 1];
  assert.equal(entry.card.status, 'done');
  assert.equal(entry.card.fullLines[0], '(25 earlier lines)', 'collapsed marker first');
  assert.equal(entry.card.fullLines.at(-1), 'out-29', 'tail preserved');
  entry.card.expanded = true;
  tui._invalidateEntry(entry);
  const flat = tui._flat().map(strip).join('\n');
  assert.ok(flat.includes('(25 earlier lines)'));
  assert.ok(flat.includes('out-29'), 'expanded card shows the collapsed tail');
  tui.close();
});

// --- assistant footer --------------------------------------------------------------

test('msgstream: footer format — model · duration · tok/s, retry, error', () => {
  assert.equal(footerLine({ model: 'kimi', seconds: 5 }), '✻ for 5s · kimi');
  assert.equal(footerLine({ model: 'kimi', seconds: 125 }), '✻ for 2m · kimi', 'minutes past 60s');
  assert.equal(footerLine({ seconds: 0 }), '✻ for 0s', 'model omitted when empty');
  assert.equal(footerLine({ model: 'kimi', seconds: 5, tokensPerSec: 42.4 }), '✻ for 5s · kimi · 42 tok/s');
  assert.equal(retryLine({ seconds: 3, attempt: 2 }), '⚠ Retrying in 3s · attempt 2');
  assert.equal(errorLine('boom\nstack line'), '✗ boom');
  assert.equal(errorLine('x'.repeat(300)).length, '✗ '.length + 160, 'errors cap at 160 cols');
});

test('msgstream: endStream closes the turn with the footer line', () => {
  const tui = headlessTui();
  tui.userMessage('hi');
  tui.streamChunk('hello');
  tui.endStream();
  const flat = tui._flat().map(strip);
  assert.ok(flat.some((l) => /^✻ for \d+s · m$/.test(l.trim())), 'muted footer with model and duration');
  tui.close();
});

// --- thinking block (reserved slot) -------------------------------------------------

test('msgstream: thinking summary line and expandable raw text', () => {
  assert.equal(thinkingSummary(1.2), 'Thought · 1.2s');
  assert.equal(thinkingSummary(65), 'Thought · 1m');
  const mk = () => ({ push: () => { const r = [{ text: 'answer' }]; r.splitIndex = 0; return r; } });
  const r = new AssistantRegion(mk, 80);
  r.push('a');
  r.setThinking('let me think\nstep two', 1200);
  let lines = r.lines(80);
  assert.equal(strip(lines[0]), 'Thought · 1.2s', 'collapsed thinking renders one summary row');
  assert.equal(strip(lines[1]), 'answer');
  assert.equal(r.heightAt(80), 2, 'height counts the summary row');
  r.thinkingExpanded = true;
  lines = r.lines(80);
  assert.deepEqual(lines.slice(0, 3).map(strip), ['Thought · 1.2s', 'let me think', 'step two'], 'expanded shows the raw reasoning');
  r.clearThinking();
  assert.deepEqual(r.lines(80).map(strip), ['answer'], 'cleared slot renders nothing');
});

// --- diff gutter (TUI path) ----------------------------------------------------------

test('msgstream: TUI diff cards render a line-number gutter and tinted hunk header', () => {
  const { items, added, removed } = unifiedDiff('const a = 1;\n', 'const a = 2;\n');
  const lines = renderFileCard({ path: 'a.js', isNew: false, items, added, removed }, { colors: true, gutter: true, theme });
  const hunk = lines.find((l) => strip(l).includes('@@'));
  assert.ok(hunk.includes(theme.permission), 'hunk header tinted with the permission color');
  const removedLine = lines.find((l) => strip(l).includes('- const a = 1;'));
  const addedLine = lines.find((l) => strip(l).includes('+ const a = 2;'));
  assert.ok(strip(removedLine).includes('  1     -'), 'old line number in the gutter, new side blank');
  assert.ok(strip(addedLine).includes('      1 +'), 'new line number in the gutter, old side blank');
  // plain + no-gutter stays the legacy shape (line mode untouched)
  const legacy = renderFileCard({ path: 'a.js', isNew: false, items, added, removed }, { colors: false });
  assert.ok(legacy.some((l) => strip(l).trimEnd().endsWith('- const a = 1;')));
});
