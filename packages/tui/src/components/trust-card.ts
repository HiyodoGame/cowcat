import type { TrustWithheld } from '@corescense/cowcat-protocol';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The pre-session workspace question (ADR-157 ①): the same shape as an approval card,
 * because it IS one — a question the interface needs answered before work starts.
 *
 * It shows what trust would actually unlock (the host's withheld counts) rather than a
 * generic warning: a bare directory with nothing gated gets no card at all.
 */
export function trustCardLines(withheld: TrustWithheld, cursor: number, cwd: string, width: number): readonly Line[] {
  const parts: string[] = [];
  if (withheld.rules > 0) parts.push(`${String(withheld.rules)} 条 allow 规则`);
  if (withheld.instructions > 0) parts.push(`${String(withheld.instructions)} 份项目指令（AGENTS.md）`);
  if (withheld.skills > 0) parts.push(`${String(withheld.skills)} 个项目技能`);
  if (withheld.mcpServers > 0) parts.push(`${String(withheld.mcpServers)} 个 MCP 服务器`);
  if (withheld.hooks > 0) parts.push(`${String(withheld.hooks)} 个 hook 文件`);

  const body: CardBodyLine[] = [
    { text: truncate(`这个工作区还未受信：${cwd}`, width - 4), token: 'text' },
    { text: '信任后以下项目层配置才会生效：', token: 'textDim' },
    { text: `  ${parts.join('、')}`, token: 'text' },
    { text: '', token: 'textDim' },
    option('信任此工作区', cursor === 0),
    option('跳过（本会话不加载项目层）', cursor === 1),
  ];
  return card({
    title: '工作区信任',
    titleToken: 'brand',
    suffix: '↑↓ 选 · 回车确认 · Esc 跳过',
    body,
    width,
  });
}

function option(text: string, selected: boolean): CardBodyLine {
  return { text: `${selected ? '❯' : ' '} ${text}`, token: selected ? 'brand' : 'textDim' };
}
