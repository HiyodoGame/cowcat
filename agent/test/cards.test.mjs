// P2 brand cards: diff folding cards + bash output card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unifiedDiff, foldItems, renderFileCard, renderGroup, highlightCode } from '../src/diffcard.js';
import { bashCardModel, renderBashCard } from '../src/outputcard.js';
import { buildWritePreview } from '../src/loop.js';

const ANSI = /\x1b\[[0-9;]*m/;

const OLD = [
  'line1',
  'line2',
  'function add(a, b) {',
  '  return a - b; // BUG',
  '}',
  'line6',
  'line7',
].join('\n');
const NEW = [
  'line1',
  'line2',
  'function add(a, b) {',
  '  return a + b;',
  '}',
  'line6',
  'line7',
].join('\n');

test('diff: unified hunk with @@ header, 2-line context, correct +/-', () => {
  const { items, added, removed } = unifiedDiff(OLD, NEW, { context: 2 });
  assert.equal(added, 1);
  assert.equal(removed, 1);
  const hunk = items.find((i) => i.kind === 'hunk');
  assert.match(hunk.header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  // header must reference the changed region start
  assert.equal(hunk.header, '@@ -2,5 +2,5 @@');
  const signs = items.filter((i) => i.kind === 'line').map((i) => i.sign).join('');
  assert.equal(signs, '  -+  ');
  const del = items.find((i) => i.sign === '-');
  assert.match(del.text, /a - b/);
  assert.equal(del.oldNo, 4);
  const add = items.find((i) => i.sign === '+');
  assert.equal(add.newNo, 4);
});

test('diff: no spurious hunks for identical files; new-file mode stats all added', () => {
  const same = unifiedDiff('a\nb', 'a\nb');
  assert.equal(same.items.filter((i) => i.kind === 'hunk').length, 0);
  assert.equal(same.added, 0);
  const created = unifiedDiff('', 'x\ny\nz');
  assert.equal(created.added, 3);
  assert.equal(created.removed, 0);
});

test('diff: folding collapses the middle with an exact count', () => {
  const a = Array.from({ length: 40 }, (_, i) => `same${i}`).join('\n');
  const bLines = Array.from({ length: 40 }, (_, i) => `same${i}`);
  bLines[20] = 'CHANGED';
  const { items } = unifiedDiff(a, bLines.join('\n'), { context: 3 });
  const { items: folded, collapsed } = foldItems(items, 6);
  const marker = folded.find((i) => i.kind === 'fold');
  assert.ok(marker, 'long diff must fold');
  assert.equal(collapsed, marker.count);
  assert.equal(folded.length, 7); // 6 visible + 1 marker
  assert.match(marker.count.toString(), /^[0-9]+$/);
  // small diffs never fold
  const small = foldItems(unifiedDiff(OLD, NEW).items, 8); // hunk header counts as an item
  assert.equal(small.collapsed, 0);
});

test('diff: group render folds to a file list beyond 3 files', () => {
  const mk = (path) => ({ path, isNew: false, items: unifiedDiff(OLD, NEW).items, added: 1, removed: 1 });
  const three = renderGroup([mk('a.js'), mk('b.js'), mk('c.js')], { colors: false });
  assert.ok(three.some((l) => l.includes('@@')), '3 files render full cards');
  const five = renderGroup([mk('a.js'), mk('b.js'), mk('c.js'), mk('d.js'), mk('e.js')], { colors: false });
  assert.ok(!five.some((l) => l.includes('@@')), '>3 files collapse to a list');
  assert.ok(five.some((l) => l.includes('d.js') && l.includes('+1 -1')));
  assert.ok(five.some((l) => l.includes('/diff')));
});

test('diff: NO_COLOR render is plain text; colors render uses ANSI tints', () => {
  const preview = { path: '/x.js', isNew: false, items: unifiedDiff(OLD, NEW).items, added: 1, removed: 1 };
  const plain = renderFileCard(preview, { colors: false }).join('\n');
  assert.ok(!ANSI.test(plain));
  assert.ok(plain.includes('-   return a - b; // BUG'));
  assert.ok(plain.includes('+   return a + b;'));
  const colored = renderFileCard(preview, { colors: true }).join('\n');
  assert.ok(ANSI.test(colored));
  assert.ok(!ANSI.test(colored.replace(/[[0-9;]*m/g, '')), 'stripped output is clean');
});

test('diff: naive syntax tinting covers strings, comments, keywords', () => {
  const out = highlightCode("const s = 'hi'; // note", true);
  assert.ok(out.includes('\x1b[38;5;75mconst'));
  assert.ok(out.includes('\x1b[38;5;220m\'hi\''));
  assert.ok(out.includes('\x1b[90m// note'));
  assert.equal(highlightCode('const s = 1;', false), 'const s = 1;');
});

test('bash card: short output shows in full, long output folds to tail 3', () => {
  const short = bashCardModel('a\nb\nc');
  assert.equal(short.folded, false);
  assert.deepEqual(short.headLines, ['a', 'b', 'c']);
  const long = bashCardModel(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'));
  assert.equal(long.folded, true);
  assert.equal(long.totalLines, 20);
  assert.deepEqual(long.tailLines, ['l17', 'l18', 'l19']);
});

test('bash card: render shows exit code, alert on failure, plain when NO_COLOR', () => {
  const model = bashCardModel('x\n' .repeat ? '1\n2\n3\n4\n5\n6' : '');
  const okLines = renderBashCard(bashCardModel('ok'), { colors: false, command: 'node -v', exitCode: 0 });
  assert.ok(okLines[0].includes('exit 0'));
  const bad = renderBashCard(model, { colors: false, command: 'make', exitCode: 2, file: '/tmp/o.log', tooLongLine: 'TOO LONG' });
  const text = bad.join('\n');
  assert.ok(text.includes('exit 2 !'));
  assert.ok(text.includes('4\n5\n6'.split('\n')[2])); // tail shows last lines
  assert.ok(text.includes('6 lines total'));
  assert.ok(text.includes('TOO LONG'));
  assert.ok(text.includes('/tmp/o.log'));
  assert.ok(!ANSI.test(text));
  const coloredBad = renderBashCard(model, { colors: true, exitCode: 2 }).join('\n');
  assert.ok(ANSI.test(coloredBad));
});

test('loop preview: Edit approval carries a real diff; Write-new is new-file mode', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-diff-'));
  const file = join(cwd, 'm.js');
  writeFileSync(file, OLD);
  const ctx = { cwd, readSet: new Set() };
  const editPreview = buildWritePreview('Edit', { file_path: 'm.js', old_string: 'return a - b; // BUG', new_string: 'return a + b;' }, ctx);
  assert.equal(editPreview.added, 1);
  assert.equal(editPreview.removed, 1);
  assert.equal(editPreview.isNew, false);
  assert.match(editPreview.items.find((i) => i.sign === '+').text, /a \+ b/);
  const writePreview = buildWritePreview('Write', { file_path: 'new.js', content: 'a\nb' }, ctx);
  assert.equal(writePreview.isNew, true);
  assert.equal(writePreview.added, 2);
});

test('loop integration: approvals receive previews, >3-file batches group, bash card persists output', async () => {
  const { runLoop } = await import('../src/loop.js');
  const { ToolRegistry } = await import('../src/tools/registry.js');
  const { ReadTool } = await import('../src/tools/read.js');
  const { EditTool } = await import('../src/tools/edit.js');
  const { WriteTool } = await import('../src/tools/write.js');
  const { BashTool } = await import('../src/tools/bash.js');
  const { Permissions } = await import('../src/permissions.js');
  const { MockUI } = await import('../src/ui.js');
  const { MockProvider, text } = await import('./mock-provider.js');

  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-diff-'));
  const files = ['a', 'b', 'c', 'd'].map((n) => join(cwd, `${n}.txt`));
  for (const f of files) writeFileSync(f, 'old\n');
  const written = [];
  const session = { append: () => {}, writeOutput: (t) => { written.push(t); return join(cwd, 'o.log'); } };
  const bigOutput = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
  const script = [
    {
      message: {
        content: [
          ...files.map((f, i) => ({ type: 'tool_use', id: `e${i}`, name: 'Write', input: { file_path: f, content: 'new\n' } })),
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'seq 1 30' } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('done'),
  ];
  const provider = new MockProvider(script);
  const registry = new ToolRegistry();
  for (const t of [ReadTool, EditTool, WriteTool, BashTool]) registry.register(t);
  const ui = new MockUI({ answers: ['y', 'y', 'y', 'y'] });
  const ctx = { cwd, readSet: new Set(files), state: {}, sessionId: 's', ui, permissions: new Permissions('default'), config: { maxTokens: 100, maxContextTokens: 100000 }, session };
  const res = await runLoop({
    provider, registry, system: 'sys', messages: [{ role: 'user', content: 'go' }], ctx, ui,
    permissions: ctx.permissions, config: ctx.config,
  });
  // 4 Write approvals, each carrying a preview, grouped as one 4-file batch
  const writeApprovals = ui.approvals.filter((a) => a.toolName === 'Write');
  assert.equal(writeApprovals.length, 4);
  assert.ok(writeApprovals.every((a) => a.hasPreview && a.preview.added === 1 && a.preview.removed === 1));
  assert.ok(writeApprovals.every((a) => a.groupTotal === 4), '>3 files must trigger group list mode');
  assert.equal(res.diffs.length, 4);
  assert.equal(readFileSync(files[0], 'utf8'), 'new\n');
  // bash output was folded and persisted
  assert.equal(ui.bashCards.length, 1);
  assert.equal(ui.bashCards[0].model.folded, true);
  assert.equal(ui.bashCards[0].exitCode, 0);
  assert.equal(written.length, 1);
  assert.match(res.lastBash.output, /\n30$/);
  assert.ok(existsSync(files[3]));
});
