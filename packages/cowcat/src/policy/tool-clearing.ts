import type { Message } from '../kernel/messages.js';

/**
 * Tool clearing — the sent view of old tool results (ADR-118).
 *
 * This is a **derived view, not a fact**: nothing here is written to the log. The
 * function is pure and deterministic (log + fixed policy in, view out), so a replay
 * reconstructs the same view the live session sent. The cost is that "what was sent"
 * is no longer byte-identical to "what the log holds"; ADR-118 ① accepts that for the
 * same reason `readFiles` (ADR-049) is allowed to be a gate rather than a message.
 *
 * The pairing rule (ADR-118 ②) is what makes this safe at the protocol level: both
 * wire shapes require every tool_use to be answered, so the assistant message carrying
 * the calls is never touched — only the `output` of old `role:'tool'` messages is
 * replaced. The placeholder is deterministic (ADR-118 ③): the byte count of the
 * original output, nothing else, so the uncleared prefix stays byte-stable for prompt
 * caching.
 */

/** Complete tool results kept in the sent view; older ones become placeholders. */
export const TOOL_CLEARING_KEEP_LAST = 2;

export interface ToolClearingSummary {
  /** How many tool messages the view replaced with a placeholder. */
  readonly cleared: number;
}

export function clearedToolPlaceholder(originalOutput: string, attachmentCount = 0): string {
  const bytes = `[已清除 ${String(utf8Length(originalOutput))} 字节]`;
  // Attachments are the priciest thing in the window (an image is ~1.5k estimated
  // tokens, ADR-069): once a result leaves the window its bytes stop riding every
  // request. The note keeps the message honest about what it no longer carries.
  return attachmentCount > 0 ? `${bytes}（另有 ${String(attachmentCount)} 个附件不再随请求发送）` : bytes;
}

/**
 * The messages a model request carries: the newest {@link TOOL_CLEARING_KEEP_LAST}
 * tool results in full, every older tool output replaced by a placeholder.
 * Returns the input array untouched when there is nothing to clear.
 */
export function clearedToolView(messages: readonly Message[]): readonly Message[] {
  const toolIndices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'tool') toolIndices.push(index);
  }
  const clearBefore = Math.max(0, toolIndices.length - TOOL_CLEARING_KEEP_LAST);
  if (clearBefore === 0) return messages;

  const cleared = new Set(toolIndices.slice(0, clearBefore));
  const view: Message[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool' || !cleared.has(index)) {
      view.push(message);
      continue;
    }
    view.push({
      ...message,
      output: clearedToolPlaceholder(message.output, message.attachments.length),
      // The placeholder says the attachments stopped traveling; carrying the reference
      // anyway would keep paying for the bytes on every request (ADR-118 ⑥).
      attachments: [],
    });
  }
  return view;
}

/** How much the view dropped, for tests and diagnostics. */
export function clearingSummary(messages: readonly Message[]): ToolClearingSummary {
  const toolCount = messages.reduce((count, message) => count + (message.role === 'tool' ? 1 : 0), 0);
  return { cleared: Math.max(0, toolCount - TOOL_CLEARING_KEEP_LAST) };
}

function utf8Length(text: string): number {
  // TextEncoder is a standard global (Node >= 11, browsers), so this stays
  // runtime-agnostic without dragging Buffer into the policy layer.
  return new TextEncoder().encode(text).length;
}
