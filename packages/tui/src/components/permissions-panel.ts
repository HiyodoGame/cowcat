import type { TuiView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';

export function permissionsPanelLines(view: TuiView, width: number): readonly Line[] {
  const body: CardBodyLine[] = view.permissionGrants.length === 0
    ? [{ text: '本会话没有有效的 always / session 授权。', token: 'textDim' }]
    : view.permissionGrants.map((grant) => {
        const [tool = '', ...subject] = grant.key.split('\0');
        return {
          text: `  ${grant.id} · ${grant.verdict} · ${tool} · ${truncate(subject.join('\0'), Math.max(8, width - 34))}`,
          token: 'tool' as const,
        };
      });
  return card({
    title: `会话授权 · ${String(view.permissionGrants.length)}`,
    titleToken: 'brand',
    suffix: '/permissions revoke <id>',
    body,
    width,
  });
}
