// Region model: per-width line caching, dirty invalidation, scroll-window
// materialization boundaries, and parity between the windowed draw path and
// the full _flat() materialization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { Region, TextRegion, UserRegion, AssistantRegion, CardRegion, materializeWindow } from '../src/tui/region.js';
import { createCard, wrapText } from '../src/tui/render.js';
import { getTheme } from '../src/tui/theme.js';
import { TuiUI } from '../src/tui/ui.js';

// Fixed-height probe region: heightAt() never materializes, render() counts.
class ProbeRegion extends Region {
  constructor(kind, lines) {
    super(kind);
    this.src = lines;
    this.renders = 0;
  }

  heightAt(_width) { return this.src.length; }
  render(_width) { this.renders++; return [...this.src]; }
}

test('region: identity — unique ids, declared kind, default fold state', () => {
  const a = new TextRegion(['x']);
  const b = new TextRegion(['y']);
  assert.equal(a.kind, 'text');
  assert.notEqual(a.id, b.id, 'regions carry identity');
  assert.equal(a.expanded, false, 'fold interface defaults to collapsed');
  a.expanded = true;
  assert.equal(a.expanded, true);
});

test('region: lines() caches per width; markDirty forces one re-render', () => {
  const r = new ProbeRegion('probe', ['a', 'b']);
  const w = 40;
  const first = r.lines(w);
  assert.equal(r.renders, 1);
  assert.equal(r.lines(w), first, 'same width hits the cache (same array identity)');
  assert.equal(r.renders, 1);
  r.markDirty();
  const again = r.lines(w);
  assert.equal(r.renders, 2, 'dirty mark invalidates the cache');
  assert.notEqual(again, first, 'fresh lines array after re-render');
  assert.deepEqual(again, ['a', 'b']);
});

test('region: width change invalidates the cached lines', () => {
  const r = new TextRegion(['hello world']);
  const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, '');
  const narrow = r.lines(5);
  assert.ok(narrow.length > 1, 'narrow width wraps to multiple rows');
  assert.equal(narrow.map(strip).join(' ').replace(/\s+/g, ' ').trim(), 'hello world', 'no characters lost in wrapping');
  assert.equal(r._rendered.width, 5);
  const wide = r.lines(80);
  assert.equal(wide.length, 1, 're-rendered at the new width');
  assert.equal(strip(wide[0]), 'hello world');
});

test('region: TextRegion wraps every source line like the old print path', () => {
  const r = new TextRegion(['one', 'two']);
  const expect = [];
  for (const l of ['one', 'two']) expect.push(...wrapText(l, 30));
  assert.deepEqual(r.lines(30), expect);
});

test('region: AssistantRegion streams, finishes, and replays on width change', () => {
  const theme = getTheme('dark', '256');
  const mk = (w) => ({
    width: w,
    push() {
      // contract: no newly closed rows, one re-rendered open-tail row
      const rows = [{ text: `row@${this.width}` }];
      rows.splitIndex = 0;
      return rows;
    },
  });
  const r = new AssistantRegion(mk, 80);
  r.push('chunk');
  assert.equal(r.done, false);
  r.finish();
  assert.equal(r.done, true);
  assert.deepEqual(r.lines(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')), ['row@80']);
  assert.deepEqual(r.lines(60).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')), ['row@60'], 'width change replays the raw stream');
  assert.equal(theme.success.length > 0, true);
});

test('region: AssistantRegion heightAt does not build text rows', () => {
  const mk = () => ({ push: () => { const r = [{ text: 'x' }]; r.splitIndex = 0; return r; } });
  const r = new AssistantRegion(mk, 80);
  r.push('a');
  assert.equal(r._rendered, null, 'nothing materialized yet');
  assert.equal(r.heightAt(80), 1);
  assert.equal(r._rendered, null, 'heightAt leaves the line cache untouched');
  assert.equal(r.lines(80).length, 1);
  assert.notEqual(r._rendered, null, 'lines() populates the cache');
});

test('region: CardRegion folds through the card and re-renders on status change', () => {
  const style = { theme: getTheme('dark', '256'), colors: false, spinFrame: 0 };
  const card = createCard('tool', '● Used Bash');
  const r = new CardRegion(card, style);
  assert.equal(r.expanded, false);
  r.expanded = true;
  assert.equal(card.expanded, true, 'fold state delegates to the card');
  const running = r.lines(60);
  assert.equal(running.length, 1, 'running card is a single spinner row');
  card.status = 'done';
  r.markDirty();
  const done = r.lines(60);
  assert.notEqual(done, running, 'status change re-renders');
  assert.ok(done[0].includes('✓'), 'done card shows the status icon');
});

test('region: materializeWindow crops mid-region and pads the tail with undefined', () => {
  const regions = [
    new ProbeRegion('a', ['a0', 'a1']),
    new ProbeRegion('b', ['b0', 'b1', 'b2']),
    new ProbeRegion('c', ['c0']),
  ];
  // window [1, 1+4): a1 | b0 b1 b2 → 4 rows exactly
  const win = materializeWindow(regions, 80, 1, 4);
  assert.deepEqual(win, ['a1', 'b0', 'b1', 'b2']);
  assert.equal(regions[2].renders, 0, 'region past the window is never rendered');
  // window [4, 8): b2 | c0, then pads with undefined (buildScreen blanks those)
  const short = materializeWindow(regions, 80, 4, 4);
  assert.deepEqual(short, ['b2', 'c0', undefined, undefined]);
  // window starting on the last row
  assert.deepEqual(materializeWindow(regions, 80, 5, 3), ['c0', undefined, undefined]);
  // window inside a single region
  assert.deepEqual(materializeWindow(regions, 80, 2, 2), ['b0', 'b1']);
  // empty transcript
  assert.deepEqual(materializeWindow([], 80, 0, 3), [undefined, undefined, undefined]);
});

test('region: materializeWindow skips fully-off-window regions even before it', () => {
  const tall = [];
  for (let i = 0; i < 10; i++) tall.push(new ProbeRegion(`t${i}`, [`L${i}`]));
  const win = materializeWindow(tall, 80, 8, 2);
  assert.deepEqual(win, ['L8', 'L9']);
  assert.equal(tall[9].renders, 1);
  // heightAt probed, render() never called for the earlier regions
  assert.ok(tall.slice(0, 8).every((r) => r.renders === 0), 'pre-window regions are counted, not rendered');
});

function headlessTui() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.9.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return tui;
}

test('region: windowed draw path is byte-identical to the full-flat slice', () => {
  const tui = headlessTui();
  tui.userMessage('你好');
  tui.streamChunk('# Title\n\nSome **bold** text.\n\n');
  tui.endStream();
  tui.toolCall('Bash', 'node -v');
  tui.toolSuccess();
  tui.print('tail line');
  const width = tui._size().width;
  const flat = tui._flat();
  for (const off of [0, 1, 3, Math.max(0, flat.length - 5)]) {
    const win = materializeWindow(tui.entries, width, off, 6);
    const expect = Array.from({ length: 6 }, (_, i) => flat[off + i]);
    assert.deepEqual(win, expect, `window at off=${off} matches flat slice`);
  }
  // offscreen regions carry no line cache (assistant stays cheap far above)
  tui.scroll = 0;
  const off = Math.max(0, tui._lineTotal(width) - 2);
  materializeWindow(tui.entries, width, off, 2);
  tui.close();
});

test('region: frame scheduling merges a burst of invalidations into one deferred draw', async () => {
  const tui = headlessTui();
  let draws = 0;
  tui.screen.draw = () => { draws++; };
  // three synchronous events in one turn of the loop
  tui.print('one');
  tui.print('two');
  tui.print('three');
  assert.equal(draws, 0, 'no synchronous write during the burst');
  await new Promise((r) => setImmediate(r));
  assert.equal(draws, 1, 'burst merged into a single deferred frame');
  // an explicit _draw forces a synchronous frame and cancels the pending one
  tui.print('four');
  tui._draw();
  assert.equal(draws, 2, 'forced frame drawn immediately');
  await new Promise((r) => setImmediate(r));
  assert.equal(draws, 2, 'cancelled deferred frame does not double-draw');
  tui.close();
});

test('region: close() cancels a pending deferred frame', async () => {
  const tui = headlessTui();
  let draws = 0;
  tui.screen.draw = () => { draws++; };
  tui.print('x');
  tui.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(draws, 0, 'no frame after close');
});
