import type { BackgroundTaskView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { choiceBlock, panelBlock, type SceneNode } from '../ui/scene.js';

const WINDOW = 6;

export function taskPanel(tasks: readonly BackgroundTaskView[], index: number, width: number, now: number): SceneNode {
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), tasks.length - WINDOW));
  return panelBlock({
    key: 'tasks', title: `后台任务 ${String(tasks.length)} · ↑↓ 选择 · x 停止 · Esc 关闭`, tone: 'brand',
    children: tasks.slice(start, start + WINDOW).map((task, offset) => {
      const command = truncate(task.command.split('\n')[0] ?? '', Math.max(8, width - 34));
      return choiceBlock(task.taskId, `${task.taskId}  ${stateLabel(task, now)}  ${command}`, {
        selected: start + offset === index, token: 'textDim',
      });
    }),
  });
}

function stateLabel(task: BackgroundTaskView, now: number): string {
  switch (task.state) {
    case 'running': return `运行中 ${duration(now - task.startedAt)}`;
    case 'exited': return task.exitCode === null ? '已结束' : `已结束(${String(task.exitCode)})`;
    case 'stopped': return '已停止';
    case 'lost': return '状态丢失';
    case 'unknown': return '状态未知';
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
}
