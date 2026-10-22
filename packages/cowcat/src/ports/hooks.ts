/**
 * Hooks — user-configured commands at lifecycle points (ADR-121/122).
 *
 * The kernel fires six events; the host decides which configured handlers match and
 * runs them. The port is the whole contract: the kernel never knows where handlers
 * come from, how they are matched, or that a process is involved at all.
 *
 * Outcomes are model-visible facts, so every effect that changes what the model sees
 * is represented here as data the kernel turns into log events — deny becomes an
 * `ok:false` tool result, context becomes a `hooks.context-added` message, a rewrite
 * becomes the `tool.finished` output (ADR-122 ④).
 */

/** The v1 event subset (ADR-122 ①). */
export type HookEventName =
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'user-prompt-submit'
  | 'stop'
  | 'session-start'
  | 'pre-compact';

export interface HookEventInput {
  readonly event: HookEventName;
  readonly sessionId: string;
  /** The session's working directory, as the hook's `cwd` input field. */
  readonly cwd: string;
  /** Tool events: the tool's name and normalized input. */
  readonly toolName?: string;
  readonly toolInput?: unknown;
  /** PostToolUse only: what the tool returned (`ok`/`output` and friends). */
  readonly toolResponse?: unknown;
  /** UserPromptSubmit only: the prompt text. */
  readonly prompt?: string;
  /** PreCompact only: what triggered the compaction. */
  readonly trigger?: string;
}

export type HookOutcome =
  | { readonly effect: 'none' }
  /** Exit 2 / permissionDecision deny: the action is refused, `reason` goes to the model. */
  | { readonly effect: 'deny'; readonly reason: string }
  /** Exit 0 `additionalContext`: injected into the conversation as a user message. */
  | { readonly effect: 'context'; readonly text: string }
  /** PostToolUse `updatedToolOutput`: replaces the output the model sees. */
  | { readonly effect: 'rewrite'; readonly output: string; readonly note: string | null }
  /** PostToolUse `decision:"block"` without a rewrite: the note rides beside the original output. */
  | { readonly effect: 'note'; readonly text: string };

export interface HookRunReport {
  readonly outcome: HookOutcome;
  /**
   * Non-blocking failures (non-zero exit, timeout, spawn error, unparseable JSON), one
   * line each. The kernel surfaces them through `turn.noted` (ADR-121 ③) — hooks never
   * fail the turn they run in.
   */
  readonly failures: readonly string[];
}

export interface HooksPort {
  /**
   * Runs every handler that matched the event, serially, host order (ADR-123 ②:
   * first deny wins; rewrites last-wins; contexts are all kept, joined by the kernel).
   * With no matching handlers this must not spawn anything and returns `none` fast.
   */
  run(input: HookEventInput, signal: AbortSignal): Promise<HookRunReport>;
}

/** What tests and sessions without hook configuration use: never matches, never fails. */
export const noHooks: HooksPort = {
  run: () => Promise.resolve({ outcome: { effect: 'none' }, failures: [] }),
};
