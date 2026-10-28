import type { TuiCommand } from '../app/commands.js';
import { truncate } from '../text/width.js';
import { choiceBlock, panelBlock, type SceneNode } from '../ui/scene.js';

const WINDOW = 7;

export function slashMenu(matches: readonly TuiCommand[], index: number, width: number): SceneNode {
  const selected = index % matches.length;
  const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), matches.length - WINDOW));
  return panelBlock({
    key: 'slash-menu', title: '命令 · ↑↓ 选择 · Tab 补全 · 回车执行', tone: 'plan',
    children: matches.slice(start, start + WINDOW).map((command, offset) => {
      const row = start + offset;
      return choiceBlock(`slash-${String(row)}`, truncate(`/${command.name}  ${command.summary}`, Math.max(8, width - 6)), {
        selected: row === selected, token: 'textDim', hit: `slash:${String(row)}`,
      });
    }),
  });
}
