import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choiceBlock, heightOf, panelBlock, spriteBlock, stackBlock, statusBlock, textBlock } from '../src/ui/scene.js';
import { line } from '../src/ui/line.js';

test('native scene nodes keep content, interaction and measured height separate', () => {
  const panel = panelBlock({
    key: 'approval:c1',
    title: 'Bash',
    tone: 'plan',
    children: [
      textBlock('subject', [line('npm test', 'text')]),
      choiceBlock('allow', '允许一次', { selected: true, hit: 'approval:0' }),
    ],
  });
  assert.equal(heightOf(panel), 4);
  assert.deepEqual(panel.children[1], {
    kind: 'choice', key: 'allow', text: '允许一次', selected: true, hit: 'approval:0', token: 'text',
  });
});

test('stacks have deliberate gaps instead of blank decorative characters', () => {
  const node = stackBlock('entry', [
    textBlock('answer', [line('回答'), line('第二行')]),
    statusBlock('working', '执行 Read', [{ label: 'glm', value: '12s' }], 'act'),
  ], 1);
  assert.equal(heightOf(node), 4);
});

test('a sprite is a fixed-size pixel matrix, not lines of ASCII art', () => {
  const node = spriteBlock('cat', [['fur', 'patch', 'nose']]);
  assert.equal(node.kind, 'sprite');
  assert.equal(heightOf(node), 1);
  assert.equal(node.pixels[0]?.[1], 'patch');
});
