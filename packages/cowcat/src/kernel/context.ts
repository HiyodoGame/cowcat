import type { Message } from './messages.js';
import type { SessionState } from './state.js';

/**
 * Why a compaction ran (ADR-070/072).
 *
 * - `auto` — the estimated context crossed the preset's ceiling.
 * - `manual` — a user asked for it.
 * - `overflow` — the provider rejected a request as too long, so the estimate ran
 *   low. The caller aims at a smaller target for this case (see `SHRINK_STEPS`).
 */
export type CompactionTrigger = 'auto' | 'manual' | 'overflow';

/**
 * The estimator's numbers, in one place (ADR-070).
 *
 * These are deliberately crude: the shape of the decision is "anchor + estimate, take
 * the larger", and every input tool we surveyed prices text without a real tokenizer
 * (opencode `Token.estimate`, DeepSeek's four-characters-per-token meter, codex's
 * `approx_token_count`). Being exact is not a property we can have without a tokenizer
 * per provider, and being *early* is cheap while being late is a hard failure.
 */
const CHARS_PER_TOKEN = 4;
/** Role framing, separators and the tool-call envelope. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Fixed prices for media, matching the order of magnitude the vendors charge. */
const IMAGE_TOKENS = 1_500;
const DOCUMENT_TOKENS = 2_000;

/** Share of the window kept free for the reply and the summary itself (opencode: 15%). */
const RESERVE_SHARE = 0.15;
/** The reserve never drops below this, unless the window itself is tiny (opencode: 16k). */
const RESERVE_MIN = 16_000;
/** A window smaller than this keeps the share only: taking 16k out of 20k leaves nothing. */
const RESERVE_MIN_WINDOW = 2 * RESERVE_MIN;

/** Recent conversation kept verbatim beside the summary (opencode's default, in tokens). */
export const RECENT_KEEP_TOKENS = 15_000;

/** How much of a rejected request's estimate each overflow retry aims at (opencode: 70/50/35%). */
export const SHRINK_STEPS = [0.7, 0.5, 0.35] as const;

export function estimateText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** One message as the request pays for it. Text only: attachments are priced by kind. */
export function estimateMessage(message: Message): number {
  switch (message.role) {
    case 'user':
      return estimateText(message.text) + MESSAGE_OVERHEAD_TOKENS;
    case 'assistant':
      return (
        estimateText(message.text) +
        message.toolCalls.reduce(
          (sum, call) => sum + estimateText(call.name) + estimateText(JSON.stringify(call.input ?? null)),
          0,
        ) +
        message.reasoning.reduce((sum, block) => sum + (block.type === 'thinking' ? estimateText(block.text) : 0), 0) +
        MESSAGE_OVERHEAD_TOKENS
      );
    case 'tool':
      return (
        estimateText(message.output) +
        message.attachments.reduce(
          (sum, attachment) => sum + (attachment.type === 'image' ? IMAGE_TOKENS : DOCUMENT_TOKENS),
          0,
        ) +
        MESSAGE_OVERHEAD_TOKENS
      );
  }
}

export function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0);
}

/**
 * The largest request the model takes while leaving room for its reply (ADR-070).
 *
 * `window - max(window × 15%, 16k)`. The same shape opencode uses, for the reason it
 * gives: the margin absorbs a single oversized step without forcing a second compaction,
 * and the summary request itself needs room. `null` when the preset declares no window —
 * then nothing can be decided locally, and only a provider rejection can bound a request.
 */
export function contextCeiling(window: number | undefined): number | null {
  if (window === undefined || window <= 0) return null;
  const reserve = Math.max(Math.floor(window * RESERVE_SHARE), window >= RESERVE_MIN_WINDOW ? RESERVE_MIN : 0);
  return window - reserve;
}

export interface ContextUsage {
  /** What the trigger compares against the ceiling: the larger of the two readings. */
  readonly total: number;
  /** Every message estimated locally, ignoring what the provider reported. */
  readonly estimated: number;
  /**
   * The last reported usage plus the messages appended since it. Zero when the provider
   * has never reported usage in this session.
   */
  readonly measured: number;
}

/**
 * How full the context is (ADR-070).
 *
 * Two readings, and the larger one wins:
 *
 * - `measured` — the provider's own count for the last request, plus local estimates for
 *   everything appended after the assistant message it produced. A provider count is
 *   only reused for the request that produced it: it describes that exact prompt.
 * - `estimated` — every message, locally. A provider that reports nothing (or a session
 *   that has not called the model yet) still gets an answer.
 *
 * Taking the larger is the safe direction to be wrong in: an overestimate compacts one
 * step early, an underestimate overflows the window.
 */
export function contextUsage(state: SessionState): ContextUsage {
  const estimated = estimateMessages(state.messages);
  const anchor = state.lastUsage;
  if (anchor === null) return { total: estimated, estimated, measured: 0 };

  let since = 0;
  for (const [index, message] of state.messages.entries()) {
    const seq = state.messageSeqs[index];
    if (seq !== undefined && seq > anchor.anchorSeq) since += estimateMessage(message);
  }
  const measured = anchor.tokens + since;
  return { total: Math.max(estimated, measured), estimated, measured };
}
