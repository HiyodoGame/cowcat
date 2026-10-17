export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * One piece of the model's own reasoning, exactly as the protocol delivered it (ADR-045).
 *
 * A block is not "some text the model thought": it is a replayable unit. Anthropic
 * requires thinking blocks to be sent back **unmodified, in their original order, with
 * the signature intact** — a modified block is a `400 invalid_request_error` (its SDK's
 * own type documentation says so in as many words). So the kernel keeps blocks rather
 * than one string, because "we did not lose the reasoning" and "we can replay it" are
 * different requirements.
 *
 * `signature` (and, for a redacted block, `data`) is an **opaque vendor token**: the
 * kernel never parses it, and an empty `signature` means the protocol has no such
 * concept at all (every OpenAI-compatible endpoint) — the same "an empty value is the
 * one the compiler can check" reasoning as `Message.assistant.text`.
 */
export type ReasoningBlock =
  | { readonly type: 'thinking'; readonly text: string; readonly signature: string }
  /**
   * Portions of the reasoning that were safety-redacted: no readable content, and the
   * payload is encrypted. It exists only so a replay can be faithful.
   */
  | { readonly type: 'redacted'; readonly data: string };

export type Message =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
      readonly reasoning: readonly ReasoningBlock[];
    }
  | { readonly role: 'tool'; readonly callId: string; readonly ok: boolean; readonly output: string };
