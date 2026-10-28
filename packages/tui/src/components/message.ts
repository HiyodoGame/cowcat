import type { AssistantEntry, UserEntry } from '../app/view.js';
import { line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';
import { renderMarkdown } from '../text/markdown.js';
import { choiceBlock, panelBlock, stackBlock, textBlock, type SceneNode } from '../ui/scene.js';

export function userMessage(entry: UserEntry, width: number): SceneNode {
  const text = entry.text === '' ? '（空输入）' : entry.text;
  return panelBlock({
    key: `user-${String(entry.seq)}`, title: entry.cron === true ? '定时任务' : '你', tone: 'user',
    children: [textBlock('content', [
      ...(entry.cron === true ? [line('无人值守：不能询问审批，做不了会报告', 'textDim')] : []),
      ...wrap(text, Math.max(8, width - 6)).map((row) => line(row, 'user')),
    ])],
  });
}

export function assistantMessage(entry: AssistantEntry, width: number, thinkingExpanded: boolean): SceneNode {
  const children: SceneNode[] = [];
  const blocks = entry.reasoning.length + entry.redactedThinking;
  if (blocks > 0) {
    children.push(choiceBlock('thinking-toggle', `思考 ${String(blocks)} 段  ${thinkingExpanded ? 'Ctrl-T 折叠' : 'Ctrl-T 展开'}`, {
      selected: thinkingExpanded, token: 'textDim', hit: 'thinking',
    }));
    if (thinkingExpanded) {
      const reasoning = entry.reasoning.flatMap((block) => wrap(block, Math.max(8, width - 4)));
      if (entry.redactedThinking > 0) reasoning.push(`（${String(entry.redactedThinking)} 段已隐藏的思考）`);
      children.push(textBlock('reasoning', reasoning.map((row) => line(row, 'textDim'))));
    }
  }
  children.push(textBlock('answer', renderMarkdown(entry.text, width, 'text')));
  if (entry.calls > 0) children.push(textBlock('calls', [line(`这一轮还带了 ${String(entry.calls)} 个工具调用`, 'textDim')]));
  return stackBlock(`assistant-${String(entry.seq)}`, children, 1);
}
