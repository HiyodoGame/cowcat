import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSmokeFrame } from '../src/smoke.js';

// These assertions are what the Node 26 CI legs are for. They fail if the platform
// native core did not resolve (optional dependency missing), did not load, or
// produced a frame whose columns do not line up — the three ways this package can
// be silently broken on a machine nobody develops on.

// Grapheme clusters, not cells: every character in this frame is one cell wide
// (ASCII plus box drawing), so the two counts agree here. Where they stop agreeing
// — wide characters in model output — is what P6 keeps a width table for
// (ADR-056); this assertion is deliberately not that table.
const CLUSTERS = new Intl.Segmenter('und', { granularity: 'grapheme' });
const clusters = (row: string): number => [...CLUSTERS.segment(row)].length;

test('native core loads and renders one frame containing the text', async () => {
  const { frame } = await renderSmokeFrame('Hello, cowcat');
  assert.ok(frame.includes('Hello, cowcat'), `text missing from frame:\n${frame}`);
});

test('every row is exactly `width` cells wide', async () => {
  const { frame, width, height } = await renderSmokeFrame('Hello, cowcat');
  const lines = frame.split('\n');
  assert.equal(lines.at(-1), '', 'captured frame ends with a newline');

  const rows = lines.slice(0, height);
  assert.equal(rows.length, height, `expected ${String(height)} rows, got ${String(rows.length)}`);
  for (const [index, row] of rows.entries()) {
    // A mis-sized row shifts every column after it, which is the failure a frame
    // made of box-drawing characters is supposed to catch.
    assert.equal(
      clusters(row),
      width,
      `row ${String(index + 1)} is ${String(clusters(row))} cells, expected ${String(width)}`,
    );
  }
  assert.ok(rows[0]?.startsWith('┌'), `box did not start at row 1 column 1:\n${frame}`);
});
