import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptBlocks } from '../src/components/transcript.js';
import { initialView, type TuiView } from '../src/app/view.js';

test('a completely empty transcript has one compact native welcome panel', () => {
  const nodes = transcriptBlocks(initialView(), { width: 80, now: 0 });
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], {
    kind: 'panel', key: 'empty-session', title: '开始新会话', tone: 'border',
    children: [{ kind: 'text', key: 'hint', rows: [{ text: '在下方输入一个问题或任务，Enter 发送。', token: 'textDim', bold: false }] }],
  });
});

test('real content and running work suppress the welcome panel', () => {
  const views: readonly TuiView[] = [
    { ...initialView(), streaming: '回答' },
    { ...initialView(), reasoningStream: '思考', reasoningShown: 2 },
    { ...initialView(), reasoningStream: '首个 delta', reasoningShown: 0 },
    { ...initialView(), pendingTools: [{ callId: 'c', name: 'Bash' }] },
    { ...initialView(), entries: [{ kind: 'notice', seq: 1, level: 'info', text: '已连接' }] },
  ];
  for (const view of views) {
    assert.ok(transcriptBlocks(view, { width: 80, now: 0 }).every((node) => node.key !== 'empty-session'));
  }
});

test('streaming text renders through the same Markdown path as the settled answer', () => {
  const streamed = '# 标题\n\n- **粗体** 项\n\n```ts\nconst x = 1;';
  const view: TuiView = { ...initialView(), streaming: streamed };
  const nodes = transcriptBlocks(view, { width: 60, now: 0 });
  const node = nodes.find((n) => n.key === 'streaming');
  assert.ok(node !== undefined && node.kind === 'text');
  const texts = node.rows.map((row) => row.text);
  assert.ok(!texts.some((text) => text.includes('# 标题')), 'heading marker is consumed, not shown raw');
  assert.ok(texts.includes('标题'));
  assert.ok(texts.some((text) => text.includes('const x = 1;')), 'an unclosed fence still shows its body');
});
