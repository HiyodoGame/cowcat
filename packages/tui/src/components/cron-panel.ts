import type { CronJobView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { choiceBlock, panelBlock, type SceneNode } from '../ui/scene.js';

const WINDOW = 6;

export function cronPanel(jobs: readonly CronJobView[], index: number, width: number, now: number): SceneNode {
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), jobs.length - WINDOW));
  return panelBlock({
    key: 'crons', title: `定时任务 ${String(jobs.length)} · ↑↓ 选择 · x 删除 · Esc 关闭`, tone: 'brand',
    children: jobs.slice(start, start + WINDOW).map((job, offset) => {
      const prompt = truncate(job.prompt.split('\n')[0] ?? '', Math.max(8, width - 44));
      return choiceBlock(job.jobId, `${job.jobId}  ${nextLabel(job, now)}  "${job.schedule}"  ${prompt}`, {
        selected: start + offset === index, token: 'textDim',
      });
    }),
  });
}

function nextLabel(job: CronJobView, now: number): string {
  if (job.nextRun === null) return job.recurring ? '不再触发' : '已触发';
  const seconds = Math.max(0, Math.round((job.nextRun - now) / 1000));
  const inWords = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
  return `${job.recurring ? '周期' : '一次性'}·${inWords}后`;
}
