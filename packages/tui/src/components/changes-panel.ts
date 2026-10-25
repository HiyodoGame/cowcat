import { changedFiles } from '../app/changes.js';
import type { TuiView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';

export function changesPanelLines(view: TuiView, width: number): readonly Line[] {
  const files = changedFiles(view);
  const body: CardBodyLine[] = files.length === 0
    ? [{ text: '本会话还没有成功的 Write / Edit。', token: 'textDim' }]
    : files.map((file) => {
        const stats = [
          file.added > 0 || file.removed > 0 ? `+${String(file.added)} -${String(file.removed)}` : null,
          file.written > 0 ? `写入 ${String(file.written)} 行` : null,
        ].filter((part) => part !== null).join(' · ');
        return {
          text: `  ${file.operations.join('/')} ${stats}  ${truncate(file.path, Math.max(8, width - 28))}`,
          token: 'tool' as const,
        };
      });
  return card({
    title: `变更文件 · ${String(files.length)}`,
    titleToken: 'brand',
    suffix: '/changes 收起',
    body,
    width,
  });
}
