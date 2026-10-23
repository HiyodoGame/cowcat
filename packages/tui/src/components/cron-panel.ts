import type { CronJobView } from '../app/view.js';
import { line, type Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The `/cron` panel (ADR-143 ③): the session's scheduled jobs, newest first.
 *
 * Same shape as the `/tasks` panel: a dock list, one `Line` per job (ADR-100/101), arrows
 * move, `x` deletes through `cron.remove`, Escape closes. A deletion removes the row only
 * when the `cron.deleted` event arrives — the event is the truth, the method answer is not.
 */
const WINDOW = 6;

export function cronPanelLines(jobs: readonly CronJobView[], index: number, width: number, now: number): readonly Line[] {
  const header = line(
    truncate(`定时任务 ${String(jobs.length)} 个 · ↑↓ 选择 · x 删除 · Esc 关闭`, width),
    'textDim',
    true,
  );
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), jobs.length - WINDOW));
  const shown = jobs.slice(start, start + WINDOW);
  const rows = shown.map((job, offset) => {
    const selected = start + offset === index;
    const marker = selected ? '❯ ' : '  ';
    // The schedule and the prompt's first line identify the job; ids have a fixed-ish width.
    const prompt = truncate(job.prompt.split('\n')[0] ?? '', Math.max(8, width - 44));
    const row = truncate(`${marker}${job.jobId}  ${nextLabel(job, now)}  "${job.schedule}"  ${prompt}`, Math.max(8, width));
    return line(row, selected ? 'act' : 'textDim', selected);
  });
  return [header, ...rows];
}

function nextLabel(job: CronJobView, now: number): string {
  if (job.nextRun === null) return job.recurring ? '不再触发' : '已触发';
  const seconds = Math.max(0, Math.round((job.nextRun - now) / 1000));
  const inWords = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
  return `${job.recurring ? '周期' : '一次性'}·${inWords}后`;
}
