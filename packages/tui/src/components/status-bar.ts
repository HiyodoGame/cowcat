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
 * Where each part comes from: the session id and the turn state are the log's; the model
 * short name and the context window arrive on `turn.opened` (ADR-102, ADR-105); the token
 * counts on `model.usage`. That is the whole rule — the bar renders facts the log already
 * recorded (the same argument ADR-012 makes for the shell) and shows nothing for a field an
 * older log does not carry.
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
  const runtime = view.scrollOffset > 0 ? `↑ 已暂停跟随 · ${String(view.newSinceScroll)} 条新输出` : null;
  if (runtime !== null) parts.push(runtime);
  if (view.todos.length > 0) {
    const done = view.todos.filter((todo) => todo.status === 'completed').length;
    parts.push(`待办 ${String(done)}/${String(view.todos.length)}`);
  }
  const background = view.tasks.filter((task) => task.state === 'running').length;
  if (background > 0) parts.push(`后台 ${String(background)}`);
  if (view.usage !== null) {
    // A share of the window the turn declared (ADR-105). `input` is the last prompt the
    // provider billed, which is the closest thing to "how full is it" that a client can know;
    // with no window, printing a percentage would be inventing the denominator.
    const window = view.contextWindow;
    if (window !== null && window > 0) {
      // Same sum the kernel anchors on (`input + cacheRead + cacheCreation + output`):
      // `input` alone excludes the cached part of a prompt, which on a cached request is
      // most of it — the bar would read "5%" while compaction is about to fire. The
      // denominator is the whole window, so >100% is possible and means the request already
      // overflowed; the compaction threshold itself is lower (`contextCeiling`).
      const used = view.usage.input + view.usage.cacheRead + view.usage.cacheCreation + view.usage.output;
      parts.push(`ctx ${String(Math.round((used / window) * 100))}%`);
    }
    parts.push(`↑${String(view.usage.input)} ↓${String(view.usage.output)}`);
  }
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
