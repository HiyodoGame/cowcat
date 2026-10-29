import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, formatCost, stripControl } from '../src/app/meter.js';
import { asideSpec } from '../src/app/rails.js';
import { initialView } from '../src/app/view.js';

/**
 * ADR-131 meter arithmetic and the ADR-129 P2-2 sanitizer. The cost formula is the
 * renderer-side mirror of the kernel's PriceTable contract: undeclared rates count as
 * zero (a partial report said in the only way a number can say it).
 */

test('costOf prices every field per 1M tokens; undeclared rates count as zero', () => {
  const usage = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheCreation: 0 };
  assert.equal(costOf(usage, { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }), 3 + 7.5 + 0.6);
  // No cache rates declared: those tokens are counted, but priced at zero — never invented.
  assert.equal(costOf(usage, { input: 3, output: 15 }), 3 + 7.5);
  assert.equal(costOf({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, { input: 3, output: 15 }), 0);
});

test('formatCost keeps two decimals so the meter reads as a meter', () => {
  assert.equal(formatCost(0.0234), '$0.02');
  assert.equal(formatCost(1.2), '$1.20');
  assert.equal(formatCost(12.4), '$12.40');
  assert.equal(formatCost(0.0001), '<$0.01', '$0.00 reads as free; a meter never says free');
  assert.equal(formatCost(0), '$0.00');
});

test('stripControl removes C0/C1 and bidi controls, keeps ordinary text intact', () => {
  assert.equal(stripControl('npm test'), 'npm test');
  assert.equal(stripControl('a\u0000b\u001Fc'), 'abc');
  assert.equal(stripControl('a\u007Fb'), 'ab');
  // A bidi override can make the card show a different sentence than the grant key
  // records; the controls go, the words stay.
  assert.equal(stripControl('safe\u202Eevil\u202Ctext'), 'safeeviltext');
});

test('the aside uses the same per-million cost arithmetic as the status meter', () => {
  const usage = { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 };
  const price = { input: 3, output: 15 };
  const view = { ...initialView(), usage, usageTotals: usage, contextWindow: 1000, price };

  const context = asideSpec(view, {}, []).panels.find((panel) => panel.title === '上下文');
  assert.equal(context?.rows.find((row) => row.label === '费用')?.value, '<$0.01');
});

test('the changes panel names only the writes CowCat actually tracked', () => {
  const panels = asideSpec(initialView(), {}, [{ path: '/work/a.ts', added: 1, removed: 0, written: 0 }]).panels;

  assert.ok(panels.some((panel) => panel.title === '文件变更'));
  assert.equal(panels.some((panel) => panel.title === 'git 变更'), false);
});
