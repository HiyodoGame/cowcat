// Metadata row: full layout, variant styling, narrow-mode degradation, and
// the frame-integration contract (row lands directly above the input block).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { metadataLine, metadataLayout, METADATA_NARROW_WIDTH } from '../src/tui/metadata.js';
import { getTheme } from '../src/tui/theme.js';
import { visibleLen } from '../src/tui/render.js';
import { TuiUI } from '../src/tui/ui.js';

const theme = getTheme('dark', '256');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('metadata: full layout joins agent · model · variant', () => {
  const line = metadataLine({ agent: 'build', model: 'kimi-k2', variant: 'plan' }, 80, theme, true);
  assert.equal(strip(line), 'build · kimi-k2 · plan');
  assert.ok(line.includes(theme.warning), 'variant uses the warning color');
  assert.ok(line.includes('\x1b[1m'), 'variant is bold');
});

test('metadata: missing slots are omitted', () => {
  assert.equal(strip(metadataLine({ model: 'm', variant: 'plan' }, 80, theme, false)), 'm · plan');
  assert.equal(strip(metadataLine({ model: 'm' }, 80, theme, false)), 'm');
  assert.equal(metadataLine({}, 80, theme, false), '', 'nothing to show -> empty row');
});

test('metadata: narrow mode (<44 cols) degrades to the model slot', () => {
  const wide = metadataLayout({ agent: 'a', model: 'model-name', variant: 'plan' }, METADATA_NARROW_WIDTH);
  assert.equal(wide.parts.length, 3, 'full layout at the threshold');
  const narrow = metadataLayout({ agent: 'a', model: 'model-name', variant: 'plan' }, METADATA_NARROW_WIDTH - 1);
  assert.deepEqual(narrow.parts.map((p) => p.kind), ['model'], 'only the model slot survives');
  assert.ok(narrow.truncated);
  const line = metadataLine({ agent: 'a', model: 'model-name', variant: 'plan' }, 20, theme, true);
  assert.equal(strip(line), 'model-name', 'narrow row renders the model only');
});

test('metadata: overlong rows are truncated to the width budget', () => {
  const line = metadataLine({ model: 'x'.repeat(100) }, 30, theme, false);
  assert.ok(visibleLen(line) <= 30);
});

test('metadata: TuiUI pins the metadata row directly above the input block', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 80;
  output.rows = 24;
  let frame = null;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.12.0', cwd: '/x',
    getModel: () => 'test-model', getMode: () => 'plan', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = (lines) => { frame = lines; };
  tui.start();
  tui.readLine();
  tui._draw();
  const height = 23; // max(10, rows - 1)
  const inputLen = tui._inputBox().length;
  const inputStart = height - inputLen - 1;
  const metaRow = strip(frame[inputStart]);
  assert.ok(metaRow.includes('test-model'), 'metadata row opens the input block');
  assert.ok(metaRow.includes('plan'), 'plan mode shows as the variant');
  assert.ok(strip(frame[inputStart + 1]).includes('›'), 'composer row follows the metadata');
  // and the input block itself keeps the metadata row as its first line
  const box = tui._inputBox();
  assert.equal(strip(box[0]).trim(), 'test-model · plan', 'metadata is the first input-block row');
  tui.close();
});
