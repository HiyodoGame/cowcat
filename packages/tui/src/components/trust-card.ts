import type { TrustWithheld } from '@corescense/cowcat-protocol';
import { line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';
import { choiceBlock, panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export function trustCard(withheld: TrustWithheld, cursor: number, cwd: string, width: number): SceneNode {
  const parts: string[] = [];
  if (withheld.rules > 0) parts.push(`${String(withheld.rules)} 条 allow 规则`);
  if (withheld.instructions > 0) parts.push(`${String(withheld.instructions)} 份项目指令（AGENTS.md）`);
  if (withheld.skills > 0) parts.push(`${String(withheld.skills)} 个项目技能`);
  if (withheld.mcpServers > 0) parts.push(`${String(withheld.mcpServers)} 个 MCP 服务器`);
  if (withheld.hooks > 0) parts.push(`${String(withheld.hooks)} 个 hook 文件`);
  return panelBlock({
    key: 'workspace-trust', title: '工作区信任', tone: 'plan', children: [
      textBlock('facts', [
        ...wrap(`这个工作区还未受信：${cwd}`, Math.max(8, width - 6)).map((row) => line(row, 'text')),
        line('信任后以下项目层配置才会生效：', 'textDim'),
        line(parts.join('、'), 'text'),
      ]),
      choiceBlock('grant', '信任此工作区', { selected: cursor === 0 }),
      choiceBlock('skip', '跳过（本会话不加载项目层）', { selected: cursor === 1, token: 'textDim' }),
      textBlock('hint', [line('↑↓ 选择 · 回车确认 · Esc 跳过', 'textDim')]),
    ],
  });
}
