import type { TuiCommand } from '../app/commands.js';
import { truncate } from '../text/width.js';
import { choiceBlock, panelBlock, type SceneNode } from '../ui/scene.js';

const WINDOW = 7;

export function commandPalette(commands: readonly TuiCommand[], index: number, width: number): SceneNode {
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), commands.length - WINDOW));
  return panelBlock({
    key: 'palette', title: '命令 · ↑↓ 选择 · 回车执行 · Esc 关闭', tone: 'brand',
    children: commands.slice(start, start + WINDOW).map((command, offset) => {
      const row = start + offset;
      return choiceBlock(`command-${String(row)}`, truncate(`/${command.name}  ${command.summary}`, Math.max(8, width - 6)), {
        selected: row === index, token: 'textDim', hit: `palette:${String(row)}`,
      });
    }),
  });
}
