import { copyFor, type Copy } from '../app/copy.js';
import type { TuiView } from '../app/view.js';
import { line, type Line } from '../ui/line.js';
import { truncate, stringWidth } from '../text/width.js';
import type { TokenName } from '../theme/tokens.js';

/**
 * The status bar: one plain-text line, whatever the terminal can print.
 *
 * The brand guide's rule for it is "any terminal, including 80 columns and no ANSI, stays
 * readable" (brand-guide §4.3) — so it is one line of text built from words that come out of
 * the copy table, never emoji or a spinner.
 *
 * What it can NOT show today, and why: the model. The session log does not record which model
 * ran a turn (`turn.opened` carries the input, and `model.message` the answer), so the
 * protocol has nothing to hand over. Reproducibility says that fact belongs in the log — the
 * same argument ADR-012 makes for the shell — and it is a kernel contract change with its own
 * ADR, not something a status bar should invent. Recorded in HANDOFF §6.
 */
export interface StatusOptions {
  readonly now: number;
  /** The columns available; a long state word is truncated rather than wrapped. */
  readonly width?: number;
}

export function statusLine(view: TuiView, options: StatusOptions = { now: 0 }): Line {
  const copy = copyFor(view.lang);
  const state = stateOf(view, copy, options.now);
  const parts: string[] = [view.sessionId ?? '（还没有会话）', state.text];
  if (view.todos.length > 0) {
    const done = view.todos.filter((todo) => todo.status === 'completed').length;
    parts.push(`待办 ${String(done)}/${String(view.todos.length)}`);
  }
  if (view.usage !== null) parts.push(`↑${String(view.usage.input)} ↓${String(view.usage.output)}`);
  if (view.closed) parts.push('连接已断开');
  const text = parts.join(' · ');
  return line(options.width === undefined ? text : truncate(text, options.width), state.token);
}

function stateOf(view: TuiView, copy: Copy, now: number): { readonly text: string; readonly token: TokenName } {
  if (view.approval !== null && view.approval.verdict === null) {
    // The actionable facts first — which tool, under which rule, and the prompt — because a
    // status bar is one row and a 64-column terminal is normal. The quip (the brand's voice)
    // lives on the card and the input line; putting it here cost the rule name its place on
    // screen (measured: the snapshot clipped exactly there).
    const nudged = now - view.approval.askedAt > 10_000 ? ` ${copy.approvalWaiting}` : '';
    return { text: `${view.approval.name}（${view.approval.rule}）${copy.approvePrompt}${nudged}`, token: 'plan' };
  }
  const state = view.turn?.state;
  switch (state) {
    case undefined:
      return { text: copy.ready, token: 'textDim' };
    case 'completed':
      return { text: copy.success, token: 'brand' };
    case 'failed':
      return {
        text: `${copy.failure}${view.turn?.reason === null || view.turn?.reason === undefined ? '' : `（${view.turn.reason}）`}`,
        token: 'alert',
      };
    case 'cancelled':
      return { text: copy.cancelled, token: 'textDim' };
    default:
      // opened / requesting / streaming / awaiting_tools / awaiting_approval / finishing all
      // mean the same thing to a reader: it is working on it.
      return { text: copy.waiting, token: 'act' };
  }
}

/** Exported for the tests that only care about the width of a token, not its colour. */
export function statusWidth(text: string): number {
  return stringWidth(text);
}
