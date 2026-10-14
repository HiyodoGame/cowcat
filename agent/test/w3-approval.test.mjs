// W3 Task 9: approval cards carry the prospective diff (preview/group) as a
// folded, ctrl+o-expandable body, in a permission-tinted frame. y/n/a key
// semantics are unchanged and global keys stay live while pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TuiUI } from '../src/tui/ui.js';
import { unifiedDiff } from '../src/diffcard.js';

function headlessTui() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.8.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return { tui, input };
}

const tick = () => new Promise((r) => setImmediate(r));

function editPreview() {
  const { items, added, removed } = unifiedDiff('const a = 1;\n', 'const a = 2;\n');
  return { path: 'src/a.js', isNew: false, items, added, removed };
}

function flatText(tui) {
  return tui._flat().join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

test('approval card: preview rows fold into the card, ctrl+o expands, frame is permission-colored', async () => {
  const { tui, input } = headlessTui();
  const p = tui.approve('Edit', 'update a.js', { preview: editPreview() });
  await tick();
  const entry = tui.entries[tui.entries.length - 1];
  assert.equal(entry.card.kind, 'approval');
  // folded: quip visible, diff body hidden
  const folded = flatText(tui);
  assert.ok(folded.includes('盯着它看三秒'));
  assert.ok(!folded.includes('(modified, +1 -1)'), 'diff rows hidden while folded');
  // frame tinted with theme.permission (asserted on the raw ANSI stream)
  const rawFolded = tui._flat().join('\n');
  assert.ok(rawFolded.includes(`${tui.theme.permission}✓`), 'approval mark uses permission SGR');
  // ctrl+o expands (Task 8 mechanism), revealing the diff rows
  input.write('\x0f');
  await tick();
  const expanded = flatText(tui);
  assert.ok(expanded.includes('src/a.js'), 'preview path rendered after expand');
  assert.ok(expanded.includes('(modified, +1 -1)'), 'preview stat rendered after expand');
  assert.ok(expanded.includes('+ const a = 2;'), 'added line rendered after expand');
  assert.ok(expanded.includes('- const a = 1;'), 'removed line rendered after expand');
  input.write('y');
  assert.equal(await p, 'y');
  tui.close();
});

test('approval card: group header when part of a multi-file batch', async () => {
  const { tui, input } = headlessTui();
  const p = tui.approve('Edit', 'update a.js', {
    preview: editPreview(),
    group: { total: 2, index: 1, previews: [editPreview(), { ...editPreview(), path: 'src/b.js' }] },
  });
  await tick();
  input.write('\x0f');
  await tick();
  const text = flatText(tui);
  assert.ok(text.includes('change 1/2'), 'group position header rendered');
  assert.ok(text.includes('src/a.js'), 'current file preview rendered');
  input.write('a');
  assert.equal(await p, 'always');
  tui.close();
});

test('approval card: n key resolves denial', async () => {
  const { tui, input } = headlessTui();
  const p = tui.approve('Write', '/tmp/x', { preview: editPreview() });
  setImmediate(() => input.write('n'));
  assert.equal(await p, 'n');
  tui.close();
});

test('approval card: scroll keys stay live while pending and do not resolve', async () => {
  const { tui, input } = headlessTui();
  const p = tui.approve('Write', '/tmp/x', {});
  let settled = false;
  p.then(() => { settled = true; });
  input.write('\x1b[5~'); // PgUp scrolls the transcript
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, 'scroll key must not resolve the approval');
  assert.ok(tui.scroll > 0, 'PgUp scrolled while pending');
  input.write('n');
  assert.equal(await p, 'n');
  tui.close();
});
