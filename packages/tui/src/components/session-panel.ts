import type { SessionSummary } from '@corescense/cowcat-protocol';
import { truncate } from '../text/width.js';
import { line } from '../ui/line.js';
import { choiceBlock, panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

const WINDOW = 7;

export function sessionPanel(sessions: readonly SessionSummary[], index: number, currentId: string | null, width: number): SceneNode {
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), sessions.length - WINDOW));
  return panelBlock({
    key: 'sessions', title: sessions.length === 0 ? '会话 · 这个工作区还没有会话' : `会话 ${String(sessions.length)} · 回车切换 · Esc 关闭`, tone: 'brand',
    children: sessions.length === 0 ? [textBlock('empty', [line('Esc 关闭', 'textDim')])] : sessions.slice(start, start + WINDOW).map((session, offset) => {
      const row = start + offset;
      const current = session.sessionId === currentId ? '（当前）' : '';
      const child = session.parentSessionId === undefined ? '' : ` · 子会话→${session.parentSessionId}`;
      const label = session.title ?? session.sessionId;
      return choiceBlock(session.sessionId, truncate(`${label}${current}${child} · ${String(session.lastSeq)} 条`, Math.max(8, width - 6)), {
        selected: row === index, token: 'textDim',
      });
    }),
  });
}
