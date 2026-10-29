import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { choiceBlock, panelBlock, spriteBlock, textBlock } from '../src/ui/scene.js';
import { line } from '../src/ui/line.js';
import { mountScene } from '../src/ui/primitives.js';
import { THEME } from '../src/theme/tokens.js';
import { mascotFrame } from '../src/components/cowcat-art.js';

test('panel borders and choice selection come from native renderables', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose } = await createTestRenderer({ width: 42, height: 10 });
  try {
    const root = new BoxRenderable(renderer, { id: 'test', width: 42, height: 10 });
    renderer.root.add(root);
    mountScene({ renderer, theme: THEME, onHit: () => undefined }, root, panelBlock({
      key: 'question', title: 'Bash', tone: 'plan', children: [
        textBlock('command', [line('npm test', 'text')]),
        choiceBlock('allow', '允许一次', { selected: true }),
      ],
    }));
    await renderOnce();
    assert.match(captureCharFrame(), /npm test/);
    const spans = captureSpans().lines.flatMap((row) => row.spans);
    assert.ok(spans.some((span) => span.bg.toInts().join(',') === RGBA.fromHex('#4A9EDA').toInts().join(',')));
  } finally {
    await dispose();
  }
});

test('rail panels use native borders and titles without a brand background wash', async () => {
  const { renderer, renderOnce, captureSpans, dispose } = await createTestRenderer({ width: 43, height: 4 });
  try {
    const root = new BoxRenderable(renderer, { id: 'test', width: 43, height: 4 });
    renderer.root.add(root);
    const binding = mountScene({ renderer, theme: THEME, onHit: () => undefined }, root, panelBlock({
      key: 'empty', title: '子代理', tone: 'brand', rail: true,
      children: [textBlock('rows', [line('暂无运行中的子代理', 'textDim')])],
    }));
    await renderOnce();
    assert.equal(binding.renderable.border, true);
    assert.equal(binding.renderable.title, ' 子代理 ');
    const brand = RGBA.fromHex('#A8C34A').toInts().join(',');
    assert.ok(captureSpans().lines.flatMap((row) => row.spans).every((span) => span.bg.toInts().join(',') !== brand));
  } finally {
    await dispose();
  }
});

test('a cow sprite paints a white face, gray fur and a gray nose without alphabet glyphs', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose } = await createTestRenderer({ width: 3, height: 1 });
  try {
    const root = new BoxRenderable(renderer, { id: 'test', width: 3, height: 1 });
    renderer.root.add(root);
    mountScene({ renderer, theme: THEME, onHit: () => undefined }, root, spriteBlock('cat', Array.from({ length: 4 }, () => ['on', 'on', 'furDark', 'furDark', 'nose', 'nose'])));
    await renderOnce();
    assert.doesNotMatch(captureCharFrame(), /[A-Za-z█]/);
    const colors = captureSpans().lines.flatMap((row) => row.spans).flatMap((span) => [span.fg.toInts().join(','), span.bg.toInts().join(',')]);
    assert.ok(colors.includes(RGBA.fromHex('#F7F5F0').toInts().join(',')));
    assert.ok(colors.includes(RGBA.fromHex('#45454C').toInts().join(',')));
    assert.ok(colors.includes(RGBA.fromHex('#A0A0A5').toInts().join(',')));
  } finally {
    await dispose();
  }
});

test('sprite cells keep one foreground color and transparent blanks', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose } = await createTestRenderer({ width: 4, height: 1 });
  try {
    const root = new BoxRenderable(renderer, { id: 'test', width: 4, height: 1 });
    renderer.root.add(root);
    mountScene({ renderer, theme: THEME, onHit: () => undefined }, root, spriteBlock('pixels', [
      ['on', 'on', null, null],
      ['on', 'on', 'nose', 'nose'],
    ]));
    await renderOnce();
    assert.match(captureCharFrame(), /^⠛⠒ {2}$/m);
    const fur = RGBA.fromHex('#F7F5F0').toInts().join(',');
    const nose = RGBA.fromHex('#A0A0A5').toInts().join(',');
    const actual = captureSpans().lines[0]?.spans.map((span) => ({
      text: span.text,
      fg: span.fg.toInts().join(','),
      bg: span.bg.toInts().join(','),
    }));
    assert.deepEqual(actual, [
      { text: '⠛', fg: fur, bg: '0,0,0,0' },
      { text: '⠒', fg: nose, bg: '0,0,0,0' },
      { text: '  ', fg: '255,255,255,255', bg: '0,0,0,0' },
    ]);
  } finally {
    await dispose();
  }
});


test('the 64 by 40 sprite mounts at 32 by 10 with distinct iris and pupil colors', async () => {
  const { renderer, renderOnce, captureSpans, dispose } = await createTestRenderer({ width: 32, height: 10 });
  try {
    const root = new BoxRenderable(renderer, { id: 'test', width: 32, height: 10 });
    renderer.root.add(root);
    const binding = mountScene({ renderer, theme: THEME, onHit: () => undefined }, root, spriteBlock('cat', mascotFrame('idle', 0, false)));
    await renderOnce();
    assert.equal(binding.renderable.width, 32);
    assert.equal(binding.renderable.height, 10);
    const colors = captureSpans().lines.flatMap((row) => row.spans).flatMap((span) => [span.fg.toInts().join(','), span.bg.toInts().join(',')]);
    assert.ok(colors.includes(RGBA.fromHex('#D4D4D2').toInts().join(',')), 'iris halo');
    assert.ok(colors.includes(RGBA.fromHex('#77777F').toInts().join(',')), 'pupil');
  } finally {
    await dispose();
  }
});
