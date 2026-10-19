import type { TodoView } from '../app/view.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The todo panel: what the agent said it is doing, and what is left.
 *
 * The markers are plain text on purpose — the brand guide's rule for anything that has to be
 * readable in a terminal with no colour and 80 columns. An in-progress item shows its
 * `activeForm` rather than its `content`, which is exactly why TodoWrite carries both: "加输入
 * 校验" is a plan, "在加输入校验" is what is happening now.
 */
const MARKER: Readonly<Record<string, string>> = {
  pending: '[ ]',
  in_progress: '[▸]',
  completed: '[x]',
};

export function todoPanelLines(todos: readonly TodoView[], width: number): readonly Line[] {
  if (todos.length === 0) return [];
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const inner = width - 4;
  const body: CardBodyLine[] = todos.map((todo) => {
    const marker = MARKER[todo.status] ?? '[?]';
    const text = todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content;
    return {
      text: `${marker} ${truncate(text, Math.max(0, inner - 4))}`,
      token: todo.status === 'completed' ? 'textDim' : todo.status === 'in_progress' ? 'brand' : 'text',
    };
  });

  return card({
    title: `待办 ${String(done)}/${String(todos.length)}`,
    titleToken: 'brand',
    body,
    width,
  });
}
