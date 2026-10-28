import type { ApprovalChoice, ApprovalView } from '../app/view.js';
import { approvalChoicesFor } from '../app/view.js';
import { copyFor } from '../app/copy.js';
import { stripControl } from '../app/meter.js';
import { line, type Line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';
import { accentBlock, choiceBlock, panelBlock, scrollTextBlock, textBlock, type SceneNode } from '../ui/scene.js';

const NUDGE_AFTER_MS = 10_000;

export interface ApprovalCardOptions {
  readonly width: number;
  readonly now: number;
  readonly cursor: number;
}

export function approvalCard(approval: ApprovalView, options: ApprovalCardOptions): SceneNode {
  const copy = copyFor('zh');
  const answered = approval.verdict !== null;
  const rows: Line[] = [
    line(answered ? describeVerdict(approval) : copy.approveQuip, answered ? 'textDim' : 'plan'),
    ...wrap(stripControl(approval.command ?? approval.path ?? ''), Math.max(8, options.width - 6)).map((text) => line(text, 'text')),
    line(`规则：${stripControl(approval.rule)}`, 'textDim'),
  ];
  for (const dimension of approval.dimensions) {
    if (dimension === 'deny-override') rows.push(line('将放宽：放行这条被规则拒绝的操作（仅此命令/路径）', 'plan'));
    if (dimension === 'unsandboxed') rows.push(line('将放宽：本次脱离沙箱执行该命令', 'plan'));
  }
  if (approval.reason !== null) rows.push(line(`理由：${stripControl(approval.reason)}`, 'textDim'));
  if (approval.warning !== null) rows.push(line(`注意：${stripControl(approval.warning)}`, 'alert'));
  const children: SceneNode[] = [scrollTextBlock('facts', rows.flatMap((row) => wrap(row.text, Math.max(8, options.width - 6)).map((text) => ({ ...row, text }))))];
  const actions: SceneNode[] = [];
  if (!answered) {
    actions.push(...approvalChoicesFor(approval.rule).map((choice, index) => choiceBlock(`approval-${String(index)}`, labelFor(choice, approval.name), {
      selected: index === options.cursor, token: 'textDim', hit: `approval:${String(index)}`,
    })));
    actions.push(textBlock('keys', [line(copy.approveKeys, 'textDim')]));
  }
  if (!answered && options.now - approval.askedAt > NUDGE_AFTER_MS) children.push(textBlock('nudge', [line(copy.approvalWaiting, 'act')]));
  return panelBlock({
    key: `approval-${approval.callId}`, title: `${stripControl(approval.name)} · ${answered ? '已回答' : '待回答'}`, tone: 'plan', children, actions,
  });
}

function labelFor(choice: ApprovalChoice, tool: string): string {
  switch (choice) {
    case 'once': return '允许一次';
    case 'session': return `本会话内 ${tool} 都不再问`;
    case 'always': return '只对这一个动作（同一条命令不再问）';
    case 'reject': return '拒绝';
  }
}

function describeVerdict(approval: ApprovalView): string {
  const copy = copyFor('zh');
  switch (approval.verdict) {
    case 'once': return '已允许（这一次）。';
    case 'always': return '已允许（只对这一个动作；同一条命令再来不会问）。';
    case 'session': return '已允许（本会话内这个工具都不再问）。';
    case 'reject': return approval.by === 'timeout' ? '没人回答，超时按拒绝处理。' : copy.denied;
    default: return `结果：${approval.verdict ?? '未知'}`;
  }
}

export function noticeBlock(level: 'info' | 'warn' | 'error', text: string, width: number): SceneNode {
  const token = level === 'error' ? 'alert' : level === 'warn' ? 'notice' : 'textDim';
  return accentBlock(`notice-${level}-${text}`, token, [textBlock('text', wrap(text, Math.max(4, width - 4)).map((row) => line(row, token)))]);
}
