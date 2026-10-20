import type { ModelUsage } from './model.js';

/**
 * Which built-in shape a delegated run takes (ADR-081 ①).
 *
 * Two, not a catalogue: `explore` is the read-only researcher that justifies the
 * feature, and `general` is the same thing with the parent's tools. Custom roles need
 * a discovery story (Skills / Hooks), which is why they are not here yet.
 */
export type SubagentRole = 'explore' | 'general';

/** How a delegated run ended. Mirrors the turn states the child can finish in. */
export type SubagentState = 'completed' | 'failed' | 'cancelled';

export interface SubagentRequest {
  /**
   * The child's session id, minted by the kernel before the spawn.
   *
   * It travels this way so the parent log can name the child before the child log
   * exists (ADR-080 ④): the parent/child link is a fact even when creation fails.
   */
  readonly sessionId: string;
  /** The call that asked for this run, for correlating the two logs. */
  readonly callId: string;
  /** 3–5 words, for the parent log and the card. Never used for routing (ADR-080 ⑤). */
  readonly description: string;
  /** The self-contained instructions. A child cannot see the parent conversation. */
  readonly prompt: string;
  readonly role: SubagentRole;
  /** The cap on the child's agentic rounds (ADR-082 ②). */
  readonly maxTurns: number;
}

export interface SubagentOutcome {
  readonly sessionId: string;
  readonly role: SubagentRole;
  readonly state: SubagentState;
  /** The child's final text. The kernel clips it to the reporting budget (ADR-082 ②). */
  readonly report: string;
  /** How many model rounds the child used. */
  readonly turns: number;
  /** True when `maxTurns` stopped it rather than the model finishing (upstream's "partial"). */
  readonly partial: boolean;
  /**
   * What the child cost, summed over its rounds.
   *
   * It stays here and in the child's own log; it is deliberately NOT folded into the
   * parent's `model.usage`, because the parent's compaction trigger is computed from
   * that anchor (ADR-082 ③).
   */
  readonly usage: ModelUsage | null;
  /** Why it did not complete, in the words of whoever knew. `null` on success. */
  readonly reason: string | null;
}

/**
 * Runs one delegated task to completion (ADR-079 ①).
 *
 * The port owns everything the kernel cannot do: creating the child session, choosing
 * its tools and rules, running its turns, and releasing its lock. The kernel owns the
 * two facts it writes about the delegation and the policy decision that allowed it.
 *
 * `signal` is the parent turn's cancellation. An implementation must stop the child and
 * return (or throw) rather than keep it running past a cancelled parent (ADR-081 ⑤).
 */
export interface SubagentPort {
  spawn(request: SubagentRequest, signal: AbortSignal): Promise<SubagentOutcome>;
}
