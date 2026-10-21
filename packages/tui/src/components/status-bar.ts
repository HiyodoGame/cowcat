import { copyFor, type Copy } from '../app/copy.js';
import { runningAgents, type TuiView } from '../app/view.js';
import { line, type Line } from '../ui/line.js';
import { truncate, stringWidth } from '../text/width.js';
import type { TokenName } from '../theme/tokens.js';

/**
 * The status bar: one plain-text line, whatever the terminal can print.
 *
 * The brand guide's rule for it is "any terminal, including 80 columns and no ANSI, stays
 * readable" (brand-guide §4.3) — so it is one line of text built from words that come out of
 * the copy table, never emoji.
 *
 * **A spinner is the one exception, decided 2026-10-21 from real use**: with a long tool call
 * the screen was indistinguishable from a hung process. It is one braille cell, drawn from
 * `now`, and `run.ts` stops the tick entirely when animations are off (`COWCAT_ANIMATIONS=off`)
 * or the turn is not running.
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
  if (view.model !== null) parts.push(shortModel(view.model));
  const elapsed = elapsedOf(view, options.now);
  if (elapsed !== null) parts.push(elapsed);
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
    default: {
      // The animation is a fact about TIME, not a decoration: a still screen on a long tool
      // call is indistinguishable from a hung process. `now` is injected, so a snapshot with
      // a fixed clock is still deterministic.
      const frame = SPINNER[Math.floor(now / 120) % SPINNER.length] ?? '·';
      return { text: `${frame} ${activityOf(view)}`, token: 'act' };
    }
  }
}

/** The braille cycle; one cell wide, so a narrow status bar loses nothing to it. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** What the turn is doing right now, in as few words as the status bar can afford. */
function activityOf(view: TuiView): string {
  const agents = runningAgents(view).length;
  const suffix = agents === 0 ? '' : ` · 子 agent ${String(agents)} 个运行中`;
  const state = view.turn?.state;
  if (state === 'awaiting_tools') {
    const names = view.pendingTools.map((tool) => tool.name);
    if (names.length > 0) return `执行 ${[...new Set(names)].join('/')}${suffix}`;
    return `准备执行工具${suffix}`;
  }
  if (state === 'streaming') return `模型输出中${suffix}`;
  if (state === 'finishing') return `收尾中${suffix}`;
  return `等模型响应${suffix}`;
}

/** `zai-coding-plan/glm-5.3-flash` → `glm-5.3-flash`: the provider is not what a session shows. */
function shortModel(model: string): string {
  const parts = model.split('/');
  return parts.at(-1) ?? model;
}

/** Seconds since the turn opened, only while it is still running. */
function elapsedOf(view: TuiView, now: number): string | null {
  const state = view.turn?.state;
  if (view.turnStartedAt === null || state === undefined || TERMINAL.has(state)) return null;
  const seconds = Math.max(0, Math.round((now - view.turnStartedAt) / 1000));
  return seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Exported for the tests that only care about the width of a token, not its colour. */
export function statusWidth(text: string): number {
  return stringWidth(text);
}
