import type { PlanView } from '../app/view.js';
import { line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';
import { choiceBlock, panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export interface PlanCardOptions {
  readonly width: number;
  readonly cursor: number;
}

export function planCard(plan: PlanView, options: PlanCardOptions): SceneNode {
  const children: SceneNode[] = [];
  for (const [index, option] of plan.plans.entries()) {
    children.push(choiceBlock(`plan-${String(index)}`, `${String(index + 1)}. ${option.title}`, {
      selected: index === options.cursor, hit: `plan:${String(index)}`,
    }));
    children.push(textBlock(`summary-${String(index)}`, wrap(option.summary, Math.max(8, options.width - 8)).map((row) => line(row, 'textDim'))));
  }
  children.push(choiceBlock('plan-none', '都不选，让模型改方案', {
    selected: plan.plans.length === options.cursor, token: 'textDim', hit: 'plan:none',
  }));
  children.push(textBlock('hint', [line('↑↓ 选择 + 回车，或直接点一行', 'textDim')]));
  return panelBlock({ key: `plan-${plan.callId}`, title: '选择一个方案', tone: 'plan', children });
}
