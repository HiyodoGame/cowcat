import { changedFiles } from '../app/changes.js';
import type { TuiView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { line } from '../ui/line.js';
import { panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export function changesPanel(view: TuiView, width: number): SceneNode {
  const files = changedFiles(view);
  return panelBlock({
    key: 'changes', title: `变更文件 ${String(files.length)} · /changes 收起`, tone: 'brand',
    children: [textBlock('items', files.length === 0 ? [line('本会话还没有成功的 Write / Edit。', 'textDim')] : files.map((file) => {
      const stats = [
        file.added > 0 || file.removed > 0 ? `+${String(file.added)} -${String(file.removed)}` : null,
        file.written > 0 ? `写入 ${String(file.written)} 行` : null,
      ].filter((part) => part !== null).join(' · ');
      return line(`${file.operations.join('/')} ${stats}  ${truncate(file.path, Math.max(8, width - 28))}`, 'tool');
    }))],
  });
}
