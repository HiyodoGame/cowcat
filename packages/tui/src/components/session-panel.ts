import type { SessionSummary } from '@corescense/cowcat-protocol';
import { line, type Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The `/sessions` picker (ADR-158): this workspace's sessions, newest first, Enter to
 * switch in place. A list, not a card — the task-panel idiom, including the window that
 * follows the selection.
 */

/** Rows the picker shows before it scrolls around the selection (the task panel's idiom). */
const WINDOW = 7;

export function sessionPanelLines(
  sessions: readonly SessionSummary[],
  index: number,
  currentId: string | null,
  width: number,
): readonly Line[] {
  const header = line(
    truncate(
      sessions.length === 0
        ? '会话 · 这个工作区还没有会话（Esc 关闭）'
        : `会话（${String(sessions.length)}） · ↑↓ 选择 · 回车切换 · Esc 关闭`,
      width,
    ),
    'textDim',
    true,
  );
  if (sessions.length === 0) return [header];
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), sessions.length - WINDOW));
  const shown = sessions.slice(start, start + WINDOW);
  const rows = shown.map((session, offset) => {
    const row = start + offset;
    const selected = row === index;
    const marker = selected ? '▸ ' : '  ';
    const current = session.sessionId === currentId ? '（当前）' : '';
    const child = session.parentSessionId === undefined ? '' : ` · 子会话→${session.parentSessionId}`;
    const label = session.title ?? session.sessionId;
    const facts = `${current}${child} · ${String(session.lastSeq)} 条`;
    return line(truncate(`${marker}${label}${facts}`, Math.max(8, width)), selected ? 'act' : 'textDim', selected);
  });
  return [header, ...rows];
}
