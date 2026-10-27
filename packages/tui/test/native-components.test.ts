import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { choiceBlock, panelBlock, spriteBlock, textBlock } from '../src/ui/scene.js';
import { line } from '../src/ui/line.js';
import { mountScene } from '../src/ui/primitives.js';
import { THEME } from '../src/theme/tokens.js';

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

test('a cow sprite paints white fur, dark patches and a pink nose without glyphs', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose } = await createTestRenderer({ width: 8, height: 3 });
  try {
    const root = new BoxRenderable(renderer, { id: 'test', width: 8, height: 3 });
    renderer.root.add(root);
    mountScene({ renderer, theme: THEME, onHit: () => undefined }, root, spriteBlock('cat', [['fur', 'patch', 'nose']]));
    await renderOnce();
    assert.doesNotMatch(captureCharFrame(), /[A-Za-z]/);
    const colors = captureSpans().lines.flatMap((row) => row.spans).map((span) => span.bg.toInts().join(','));
    assert.ok(colors.includes(RGBA.fromHex('#F7F5F0').toInts().join(',')));
    assert.ok(colors.includes(RGBA.fromHex('#141419').toInts().join(',')));
    assert.ok(colors.includes(RGBA.fromHex('#E8A0A0').toInts().join(',')));
  } finally {
    await dispose();
  }
});
