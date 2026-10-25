import type { HooksPort, ModelPort, ModelUsage, ToolSpec } from '../ports/index.js';
import { contextCeiling, estimateMessage, RECENT_KEEP_TOKENS } from './context.js';
import type { Message } from './messages.js';
import type { ModelPreset } from './preset.js';
import type { Session } from './session.js';
import { COWCAT_SYSTEM_PROMPT } from './system-prompt.js';
import type { CompactionTrigger } from './context.js';

/**
 * Compaction: replace the oldest part of the conversation with a summary (ADR-072).
 *
 * Three properties are the whole design:
 *
 * 1. **Not a turn.** It opens no turn, writes no `model.message`, and asks nobody for
 *    approval. It is a maintenance operation on the session's history, so it runs
 *    between model calls, inside whatever turn happens to be open.
 * 2. **The request is a prefix of the real one.** Same system, same tools,
 *    and the shadowed messages byte-for-byte, with the instruction appended as one final
 *    user message. Providers cache prefixes, so the only uncached part is the instruction
 *    and the summary. Every upstream tool that writes summaries does this.
 * 3. **Failure is not fatal.** The session keeps its previous history and the caller gets
 *    a reason; a compaction that cannot run must never cost the user their turn (ADR-069
 *    taught this the expensive way).
 */

/**
 * The instruction. Sections are the ones the four tools we surveyed converge on: what
 * the user wanted, decisions, files, errors and fixes, and what is still pending — plus
 * an explicit "do not call tools", because the request carries the real tool list (for
 * prefix parity) and a model that calls one would produce no summary.
 */
export const COMPACT_INSTRUCTION = `You are compacting an earlier part of this conversation so it can continue in a smaller context.

Produce a handoff summary for another agent that will resume the work. Use exactly these sections, in this order, with terse single-line bullets — keep every heading, write "(none)" when a section is empty:

## Objective
What the user is trying to accomplish, in their own terms.

## Requirements
Constraints, preferences and scope boundaries the user stated.

## Decisions
What was decided and why.

## Work State
Completed / in progress / blocked.

## Files
Paths that matter, and why. Prefer few, exact paths over a list of everything touched.

## Errors and Fixes
What failed and how it was resolved, including user corrections.

## Next Step
The single next action that follows from the most recent request.

Rules:
- Preserve exact file paths, commands, error strings, identifiers and numbers.
- Do not restate instructions or setup that the next agent receives separately.
- Do not mention this summary or that the context was compacted.
- Do not call tools. Reply with the summary text only.`;

/** What the model sees in place of the replaced messages (ADR-071's `summary` field). */
export function summaryMessage(text: string): string {
  return `This session continues from a checkpoint. The summary below covers the earlier conversation.

<summary>
${text.trim()}
</summary>

Continue from where the conversation left off. Do not acknowledge this checkpoint.`;
}

export interface CompactDeps {
  readonly session: Session;
  readonly model: ModelPort;
  readonly preset: ModelPreset;
  /** The tool list the real request carries, sent again here so the prefix matches. */
  readonly tools: readonly ToolSpec[];
  /** Overrides RECENT_KEEP_TOKENS. */
  readonly keepTokens?: number;
  /**
   * Hooks the host wired (ADR-122). Omitted means no PreCompact hook fires. `cwd` is the
   * session's working directory for the hook input.
   */
  readonly hooks?: { readonly port: HooksPort; readonly cwd: string };
}

export interface CompactOutcome {
  readonly ok: boolean;
  /** Why it did not run, or why it failed. `null` on success and on "nothing to compact". */
  readonly reason: string | null;
  /** How many messages the summary replaced (0 when nothing happened). */
  readonly dropped: number;
}

/**
 * Where the kept tail starts, as an index into `messages`.
 *
 * Walk back from the end while the tail still fits `keep`, then move forward to the next
 * **user** message: a tool call and its results are one unit, and a request that cut
 * between them would be rejected by the protocol (Anthropic requires every `tool_use` to
 * be answered). Keeping at least one exchange also keeps the "continue from here" shape
 * the model needs.
 */
export function selectTailStart(messages: readonly Message[], keep: number): number {
  let total = 0;
  let start = messages.length;
  while (start > 0) {
    const previous = messages[start - 1];
    if (previous === undefined) break;
    const next = total + estimateMessage(previous);
    if (next > keep) break;
    total = next;
    start--;
  }
  while (start < messages.length && messages[start]?.role !== 'user') start++;

  // Never keep nothing. If the budget was too small even for one exchange, keep the
  // newest one whole: "compact" that replaced everything would be the reset the user
  // explicitly did not want.
  if (start >= messages.length) {
    for (let index = messages.length - 1; index > 0; index--) {
      if (messages[index]?.role === 'user') {
        start = index;
        break;
      }
    }
  }
  return start;
}

/**
 * Summarize the oldest part of the conversation into one event (ADR-071/072).
 *
 * Writes, in order: `context.compaction.started`, then either `context.compacted` +
 * `context.compaction.finished { ok: true }`, or just `context.compaction.finished
 * { ok: false }`. Nothing is written when there is nothing to compact — a session that
 * is already small stays untouched.
 */
export async function compactContext(
  deps: CompactDeps,
  trigger: CompactionTrigger,
  signal: AbortSignal,
): Promise<CompactOutcome> {
  const { session, model, preset } = deps;
  // The tail must leave room for the summary and for the reply that follows it, so it is
  // capped at half the ceiling. A 15000-token default means nothing in a 20k window.
  const requested = deps.keepTokens ?? RECENT_KEEP_TOKENS;
  const ceiling = contextCeiling(preset.limits.context);
  const keep = ceiling === null ? requested : Math.max(0, Math.min(requested, Math.floor(ceiling / 2)));
  const { messages, messageSeqs } = session.state;

  const start = selectTailStart(messages, keep);
  if (start === 0) return { ok: false, reason: null, dropped: 0 };

  const shadowedMessages = messages.slice(0, start);
  const shadowedSeqs = messageSeqs.slice(0, start);
  const throughSeq = shadowedSeqs[shadowedSeqs.length - 1];
  if (throughSeq === undefined) return { ok: false, reason: null, dropped: 0 };

  // PreCompact (ADR-122 ①): fires only when a compaction will actually run — announcing
  // a compaction that the size check then skips would be a lie. v1 is observation-only.
  // A throwing port is a note, never a dead compaction (ADR-121 ③).
  if (deps.hooks !== undefined) {
    let report: { readonly failures: readonly string[] };
    try {
      report = await deps.hooks.port.run(
        {
          event: 'pre-compact',
          sessionId: session.state.sessionId,
          cwd: deps.hooks.cwd,
          trigger,
        },
        signal,
      );
    } catch (error) {
      report = { failures: [`hook 抛错：${error instanceof Error ? error.message : String(error)}`] };
    }
    for (const failure of report.failures) {
      try {
        await session.emit({
          type: 'turn.noted',
          turnId: session.turnId,
          note: 'hook-failed',
          message: `hook 失败：${failure}`,
        });
      } catch {
        // Same rule as `recordNote`: a log that cannot take the notice must not fail the compaction.
      }
    }
  }

  await session.emit({ type: 'context.compaction.started', turnId: session.turnId, trigger, model: preset.model });

  try {
    const request = {
      messages: [...shadowedMessages, { role: 'user', text: COMPACT_INSTRUCTION } as const],
      // The same tools the conversation request carries: they are part of the prefix, and
      // omitting them would throw away the cache this call exists to reuse. The
      // instruction says not to call them; a call that arrives anyway is ignored.
      tools: deps.tools,
      model: preset.model,
      system: COWCAT_SYSTEM_PROMPT,
      ...(preset.limits.output === undefined ? {} : { maxTokens: preset.limits.output }),
    };

    let text = '';
    let usage: ModelUsage | null = null;
    for await (const chunk of model.stream(request, signal)) {
      if (chunk.type === 'text') text += chunk.text;
      else if (chunk.type === 'usage') usage = chunk.usage;
    }

    if (text.trim() === '') {
      await finish(session, false, 'the summarizer produced no text');
      return { ok: false, reason: 'the summarizer produced no text', dropped: 0 };
    }

    await session.emit({
      type: 'context.compacted',
      turnId: session.turnId,
      trigger,
      summary: summaryMessage(text),
      throughSeq,
      shadowed: shadowedSeqs,
      dropped: shadowedSeqs.length,
      model: preset.model,
      usage,
    });
    await finish(session, true, null);
    return { ok: true, reason: null, dropped: shadowedSeqs.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The turn that triggered this keeps its history: a summary is an optimisation, and
    // an optimisation that fails must not become the reason a turn dies.
    await finish(session, false, reason);
    return { ok: false, reason, dropped: 0 };
  }
}

async function finish(session: Session, ok: boolean, error: string | null): Promise<void> {
  await session.emit({ type: 'context.compaction.finished', turnId: session.turnId, ok, error });
}
