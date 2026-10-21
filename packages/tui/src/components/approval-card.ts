import type { ApprovalChoice, ApprovalView } from '../app/view.js';
import { APPROVAL_CHOICES } from '../app/view.js';
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
  /** Which answer is highlighted; `APPROVAL_CHOICES` order. */
  readonly cursor: number;
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
  // The only line on this card that is not dim: a warning is the reason to read it twice.
  if (approval.warning !== null) body.push({ text: `注意：${approval.warning}`, token: 'alert' });
  if (!answered) {
    // The four answers as rows, because "remember to type always" is a memory test, not a
    // choice. The letters still work for anyone who has the habit (run.ts keeps them).
    for (const [index, choice] of APPROVAL_CHOICES.entries()) {
      const selected = index === options.cursor;
      body.push({
        text: `${selected ? '▸' : ' '} ${labelFor(choice, approval.name)}`,
        token: selected ? 'act' : 'textDim',
      });
    }
    body.push({ text: copy.approveKeys, token: 'textDim' });
  }
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

/** The option labels. The session grant names the tool: that was #96's whole confusion. */
function labelFor(choice: ApprovalChoice, tool: string): string {
  switch (choice) {
    case 'once':
      return '允许一次';
    case 'session':
      return `本会话内 ${tool} 都不再问`;
    case 'always':
      return '只对这一个动作（同一条命令不再问）';
    case 'reject':
      return '拒绝';
  }
}

function describeVerdict(approval: ApprovalView): string {
  const copy = copyFor('zh');
  switch (approval.verdict) {
    case 'once':
      return '已允许（这一次）。';
    case 'always':
      return '已允许（只对这一个动作；同一条命令再来不会问）。';
    case 'session':
      return '已允许（本会话内这个工具都不再问）。';
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
