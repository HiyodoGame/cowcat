import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEntryCache, tailForRows } from '../src/components/entry-cache.js';
import { initialView, type Entry, type TuiView } from '../src/app/view.js';
import { line } from '../src/ui/line.js';
import { graphemes } from '../src/text/width.js';
import { wrap } from '../src/text/wrap.js';

function toolEntry(): Entry {
  return {
    kind: 'tool',
    seq: 1,
    callId: 'call_1',
    name: 'Edit',
    ok: true,
    output: '',
    truncation: null,
    attachments: ['image.png'],
    path: '/work/a.ts',
  };
}

function viewWithCall(view: TuiView): TuiView {
  return {
    ...view,
    calls: { call_1: { name: 'Edit', input: { old_string: 'a', new_string: 'b' } } },
    attachments: {
      'image.png': { path: 'image.png', mediaType: 'image/png', width: 10, height: 10, pages: null, status: 'loading', bytes: null, reason: null },
    },
  };
}

test('entry rendering is reused only while every rendering dependency is unchanged', () => {
  let renders = 0;
  const cached = createEntryCache(() => {
    renders += 1;
    return { lines: [line(`render ${String(renders)}`)], images: [] };
  });
  const entry = toolEntry();
  const base = viewWithCall(initialView());
  const first = cached(entry, base, 80);
  const second = cached(entry, base, 80);
  assert.equal(second, first);
  assert.equal(renders, 1);

  const widthChanged = cached(entry, base, 100);
  assert.notEqual(widthChanged, first);
  assert.equal(renders, 2);

  const expanded = cached(entry, { ...base, expanded: ['call_1'] }, 100);
  assert.notEqual(expanded, widthChanged);
  assert.equal(renders, 3);

  const callChanged = cached(
    entry,
    { ...base, expanded: ['call_1'], calls: { call_1: { name: 'Edit', input: { old_string: 'b', new_string: 'c' } } } },
    100,
  );
  assert.notEqual(callChanged, expanded);
  assert.equal(renders, 4);

  const attachmentChanged = cached(
    entry,
    {
      ...base,
      expanded: ['call_1'],
      attachments: {
        'image.png': { path: 'image.png', mediaType: 'image/png', width: 10, height: 10, pages: null, status: 'failed', bytes: null, reason: 'gone' },
      },
    },
    100,
  );
  assert.notEqual(attachmentChanged, callChanged);
  assert.equal(renders, 5);

  cached(entry, { ...base, expanded: ['call_1'], thinkingExpanded: true }, 100);
  assert.equal(renders, 6);
});

test('the reasoning suffix is bounded before wrapping and preserves the tail', () => {
  const text = '思'.repeat(30_000);
  const suffix = tailForRows(text, 96, 6);

  assert.ok(graphemes(suffix).length <= 96 * 6 * 2);
  assert.ok(suffix.endsWith('思'.repeat(100)));
  assert.equal(tailForRows('short', 96, 6), 'short');
});

test('tail wrapping preserves the original final rows across spaces and newlines', () => {
  const cases = [
    { text: 'a i jjj j kkk '.repeat(200), width: 5 },
    { text: 'alpha beta gamma '.repeat(500) + '\n' + '思'.repeat(2_000), width: 7 },
    { text: '思 思 思 '.repeat(2_000), width: 9 },
  ];

  for (const { text, width } of cases) {
    const actual = wrap(tailForRows(text.trim(), width, 6), width).slice(-6);
    const expected = wrap(text.trim(), width).slice(-6);
    assert.deepEqual(actual, expected);
  }
});
