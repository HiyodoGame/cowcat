import type { TodoView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { line } from '../ui/line.js';
import { panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export function todoPanel(todos: readonly TodoView[], width: number): SceneNode {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return panelBlock({
    key: 'todos', title: `待办 ${String(done)}/${String(todos.length)}`, tone: 'brand',
    children: [textBlock('items', todos.map((todo) => {
      const text = todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content;
      return line(truncate(text, Math.max(8, width - 6)), todo.status === 'completed' ? 'textDim' : todo.status === 'in_progress' ? 'brand' : 'text');
    }))],
  });
}
