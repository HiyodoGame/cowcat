import type { ModelSelectionSummary, ModelSummary } from '@corescense/cowcat-protocol';
import { truncate } from '../text/width.js';
import { line } from '../ui/line.js';
import { choiceBlock, panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

const WINDOW = 7;

export function modelPanel(models: readonly ModelSummary[], index: number, current: ModelSelectionSummary | null, preset: string | null, width: number): SceneNode {
  const efforts = preset === null ? [] : models.find((entry) => entry.id === preset)?.efforts ?? [];
  const count = preset === null ? models.length : efforts.length;
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), count - WINDOW));
  const children: SceneNode[] = [];
  if (count === 0) children.push(textBlock('empty', [line(preset === null ? '宿主没有可用的 preset（先配置 model）' : '这个模型没有可选档位', 'textDim')]));
  if (preset !== null) {
    children.push(...efforts.slice(start, start + WINDOW).map((effort, offset) => choiceBlock(effort, `${effort}${current?.id === preset && current.effort === effort ? '（当前）' : ''}`, {
      selected: start + offset === index, token: 'textDim',
    })));
  } else {
    children.push(...models.slice(start, start + WINDOW).map((model, offset) => choiceBlock(model.id, truncate(`${model.id}${current?.id === model.id ? '（当前）' : ''}${model.efforts.length === 0 ? '' : ` · effort: ${model.efforts.join('/')}`}`, Math.max(8, width - 6)), {
      selected: start + offset === index, token: 'textDim',
    })));
  }
  return panelBlock({ key: 'models', title: preset === null ? '选择模型' : `${preset} · 选择推理力度`, tone: 'brand', children });
}
