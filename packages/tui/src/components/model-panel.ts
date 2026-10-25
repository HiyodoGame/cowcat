import type { ModelSelectionSummary, ModelSummary } from '@corescense/cowcat-protocol';
import { line, type Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The `/model` picker (ADR-161 ②): the host's presets, ↑↓ + Enter — the interactive
 * shape Claude Code / Codex / OpenCode all converged on, replacing the old
 * type-the-exact-id-or-read-a-notice flow. Phase two lists the chosen preset's
 * reasoning efforts (the Codex two-step), so effort stops being a `/config` incantation.
 */

/** Rows the panel shows before it scrolls around the selection (the task panel's idiom). */
const WINDOW = 7;

export function modelPanelLines(
  models: readonly ModelSummary[],
  index: number,
  current: ModelSelectionSummary | null,
  preset: string | null,
  width: number,
): readonly Line[] {
  if (preset !== null) {
    const model = models.find((entry) => entry.id === preset);
    const efforts = model?.efforts ?? [];
    const header = line(
      truncate(`${preset} · 选择推理力度 · ↑↓ 选择 · 回车确认 · Esc 返回`, width),
      'textDim',
      true,
    );
    const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), efforts.length - WINDOW));
    const rows = efforts.slice(start, start + WINDOW).map((effort, offset) => {
      const row = start + offset;
      const selected = row === index;
      const now = current !== null && current.id === preset && current.effort === effort ? '（当前）' : '';
      return line(
        truncate(`${selected ? '▸ ' : '  '}${effort}${now}`, Math.max(8, width)),
        selected ? 'act' : 'textDim',
        selected,
      );
    });
    return [header, ...rows];
  }

  const header = line(
    truncate(
      models.length === 0
        ? '模型 · 宿主没有可用的 preset（先配置 model）'
        : `模型（${String(models.length)}） · ↑↓ 选择 · 回车确认 · Esc 关闭`,
      width,
    ),
    'textDim',
    true,
  );
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), models.length - WINDOW));
  const rows = models.slice(start, start + WINDOW).map((model, offset) => {
    const row = start + offset;
    const selected = row === index;
    const marker = selected ? '▸ ' : '  ';
    const now = current !== null && current.id === model.id ? '（当前）' : '';
    const efforts = model.efforts.length === 0 ? '' : ` · effort: ${model.efforts.join('/')}`;
    return line(
      truncate(`${marker}${model.id}${now}${efforts}`, Math.max(8, width)),
      selected ? 'act' : 'textDim',
      selected,
    );
  });
  return [header, ...rows];
}
