import type { TuiView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { line } from '../ui/line.js';
import { panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export function permissionsPanel(view: TuiView, width: number): SceneNode {
  return panelBlock({
    key: 'permissions', title: `会话授权 ${String(view.permissionGrants.length)} · /permissions revoke <id>`, tone: 'brand',
    children: [textBlock('items', view.permissionGrants.length === 0
      ? [line('本会话没有有效的 always / session 授权。', 'textDim')]
      : view.permissionGrants.map((grant) => {
        const [tool = '', ...subject] = grant.key.split('\0');
        return line(`${grant.id} · ${grant.verdict} · ${tool} · ${truncate(subject.join('\0'), Math.max(8, width - 34))}`, 'tool');
      }))],
  });
}
