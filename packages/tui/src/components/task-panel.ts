import type { BackgroundTaskView } from '../app/view.js';
import { line, type Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The `/tasks` panel (ADR-113): the session's background tasks, newest first.
 *
 * A list, not a card: it lives in the dock, one `Line` per task (ADR-100/101), and the
 * only interactive key it owns is `x` — arrows move, Escape closes.
 */

/** Rows the panel shows before it scrolls around the cursor. */
const WINDOW = 6;

export function taskPanelLines(
  tasks: readonly BackgroundTaskView[],
  index: number,
  width: number,
  now: number,
): readonly Line[] {
  const header = line(
    truncate(`后台任务（${String(tasks.length)}） · ↑↓ 选择 · x 停止 · Esc 关闭`, width),
    'textDim',
    true,
  );
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), tasks.length - WINDOW));
  const shown = tasks.slice(start, start + WINDOW);
  const rows = shown.map((task, offset) => {
    const selected = start + offset === index;
    const marker = selected ? '▸ ' : '  ';
    const state = stateLabel(task, now);
    // The command is the identifying part; the id and the state have fixed-ish widths.
    const command = truncate(task.command.split('\n')[0] ?? '', Math.max(8, width - 32));
    // Truncate the assembled row too: a narrow terminal must not turn one dock Line into
    // two visual rows (ADR-100/101 — the dock budget counts Lines, not wrapped rows).
    const row = truncate(`${marker}${task.taskId}  ${state}  ${command}`, Math.max(8, width));
    return line(row, selected ? 'act' : 'textDim', selected);
  });
  return [header, ...rows];
}

function stateLabel(task: BackgroundTaskView, now: number): string {
  switch (task.state) {
    case 'running':
      return `运行中 ${duration(now - task.startedAt)}`;
    case 'exited':
      return task.exitCode === null ? '已结束' : `已结束(${String(task.exitCode)})`;
    case 'stopped':
      return '已停止';
    case 'lost':
      return '状态丢失';
    case 'unknown':
      return '状态未知';
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
}
