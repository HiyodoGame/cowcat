import type { ApprovalView } from '../app/view.js';
import { copyFor } from '../app/copy.js';
import { card, type CardBodyLine } from '../ui/card.js';
import { line, type Line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';

/**
 * The approval card: the one card that is waiting for a person.
 *
 * It carries the brand guide's voice (§2.2) and its interaction rule (§4.3: "审批等待即互动"
 * — a pending question is not a silent hang). The nudge after ten seconds is a fact the card
 * can state because `approval.requested` carries a timestamp and the frame builder is given
 * a clock; nothing else in the interface needs to know what time it is.
 *
 * The keys live on the input line (see `session-frame`), not in the card, for one measured
 * reason: a status row or a card title is one line, and at 64 columns the rule name was the
 * first thing to fall off the end when the prompt was in it too.
 */
const NUDGE_AFTER_MS = 10_000;

export interface ApprovalCardOptions {
  readonly width: number;
  /** Milliseconds now. Injected: a card that read the clock would not be a pure function. */
  readonly now: number;
}

export function approvalCardLines(approval: ApprovalView, options: ApprovalCardOptions): readonly Line[] {
  const copy = copyFor('zh');
  const answered = approval.verdict !== null;
  const waitingLong = !answered && options.now - approval.askedAt > NUDGE_AFTER_MS;
  const body: CardBodyLine[] = [
    { text: answered ? describeVerdict(approval) : copy.approveQuip, token: answered ? 'textDim' : 'plan' },
    { text: `规则：${approval.rule}`, token: 'textDim' },
  ];
  if (approval.reason !== null) body.push({ text: `理由：${approval.reason}`, token: 'textDim' });
  if (!answered) body.push({ text: copy.approveKeys, token: 'textDim' });
  if (waitingLong) {
    // §2.2's line for exactly this moment. It is the whole "waiting is an interaction" rule.
    body.push({ text: copy.approvalWaiting, token: 'act' });
  }

  return card({
    title: `⚠ ${approval.name}`,
    titleToken: 'plan',
    suffix: answered ? '[已答]' : '[待回答]',
    body,
    width: options.width,
  });
}

function describeVerdict(approval: ApprovalView): string {
  const copy = copyFor('zh');
  switch (approval.verdict) {
    case 'once':
      return '已允许（这一次）。';
    case 'always':
      return '已允许（以后同类都不再问）。';
    case 'reject':
      return approval.by === 'timeout' ? '没人回答，超时按拒绝处理。' : copy.denied;
    default:
      return `结果：${approval.verdict ?? '未知'}`;
  }
}

/** A one-line notice, used where a card would be too much. */
export function noticeLines(level: 'info' | 'warn' | 'error', text: string, width: number): readonly Line[] {
  const marker = level === 'info' ? '·' : '!';
  const token = level === 'error' ? 'alert' : level === 'warn' ? 'notice' : 'textDim';
  const room = Math.max(4, width - 2);
  const rows = wrap(text, room);
  return rows.map((row, index) => line(`${index === 0 ? `${marker} ` : '  '}${row}`, token));
}
