import type { Entry, TuiView } from '../app/view.js';
import { revealedReasoning } from '../app/view.js';
import { noticeBlock } from './approval-card.js';
import { assistantMessage, userMessage } from './message.js';
import { callSummary, runningToolCard, toolCard } from './tool-card.js';
import { line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';
import { createEntryCache, tailForRows } from './entry-cache.js';
import { accentBlock, panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export interface TranscriptOptions {
  readonly width: number;
  readonly now: number;
}

const cachedEntryNode = createEntryCache(entryNode);

export function transcriptBlocks(view: TuiView, options: TranscriptOptions): readonly SceneNode[] {
  const nodes = view.entries.map((entry) => cachedEntryNode(entry, view, options.width));
  const thinking = revealedReasoning(view).trim();
  if (thinking !== '') {
    const width = Math.max(8, options.width - 4);
    const rows = wrap(tailForRows(thinking, width, 6), width);
    nodes.push(accentBlock('live-thinking', 'plan', [textBlock('thinking', [
      line('思考中', 'plan', true),
      ...rows.slice(-6).map((row) => line(row, 'textDim')),
    ])]));
  }
  for (const tool of view.pendingTools) {
    nodes.push(runningToolCard(tool.callId, tool.name, callSummary(view.calls[tool.callId]?.input), options.width, view.toolOutput[tool.callId]));
  }
  if (view.streaming !== '') nodes.push(textBlock('streaming', wrap(view.streaming, options.width).map((row) => line(row, 'text'))));
  if (nodes.length === 0 && view.reasoningStream === '') return [panelBlock({
    key: 'empty-session', title: '开始新会话', tone: 'border',
    children: [textBlock('hint', [line('在下方输入一个问题或任务，Enter 发送。', 'textDim')])],
  })];
  return nodes;
}

function entryNode(entry: Entry, view: TuiView, width: number): SceneNode {
  switch (entry.kind) {
    case 'user': return userMessage(entry, width);
    case 'assistant': return assistantMessage(entry, width, view.thinkingExpanded);
    case 'tool': return toolCard(entry, view, width);
    case 'notice': return noticeBlock(entry.level, entry.text, width);
  }
}
