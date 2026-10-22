import type { PlanView } from '../app/view.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';

/**
 * The plan review card (ADR-125 ③): the model's implementation options, one row each,
 * with a trailing "none of them" row. It borrows the approval card's interaction rule —
 * a pending question is not a silent hang — and its click targets (`plan:<index>`), so
 * run.ts can answer a click the same way it answers the approval rows.
 */
export interface PlanCardOptions {
  readonly width: number;
  /** Which row is highlighted: 0..plans.length, the last row being "none". */
  readonly cursor: number;
}

export function planCardLines(plan: PlanView, options: PlanCardOptions): readonly Line[] {
  const body: CardBodyLine[] = [];
  for (const [index, option] of plan.plans.entries()) {
    const selected = index === options.cursor;
    body.push({
      text: `${selected ? '▸' : ' '} ${String(index + 1)}. ${option.title}`,
      token: selected ? 'act' : 'text',
      hit: `plan:${String(index)}`,
    });
    for (const wrapped of wrap(option.summary, Math.max(20, options.width - 6))) {
      body.push({ text: `     ${wrapped}`, token: 'textDim' });
    }
  }
  const noneIndex = plan.plans.length;
  const noneSelected = noneIndex === options.cursor;
  body.push({
    text: `${noneSelected ? '▸' : ' '} ✕ 都不选，让模型改方案`,
    token: noneSelected ? 'act' : 'textDim',
    hit: `plan:none`,
  });
  body.push({ text: '↑↓ 选择 + 回车，或直接点一行', token: 'textDim' });

  return card({
    title: '选择一个方案',
    titleToken: 'plan',
    suffix: '[待选择]',
    body,
    width: options.width,
  });
}
