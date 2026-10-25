// The model protocol's shared vocabulary (ADR-035, ADR-040).
//
// These types live on their own rather than in `ports/index.ts` because the kernel's
// event union has to name them — `model.usage` carries a usage, and `model.message`
// carries the stop reason — while `ports/index.ts` already imports the event union's
// type. Keeping them in a file that imports nothing but `kernel/messages` is what
// keeps those two from importing each other.

/**
 * What one call cost, in the four buckets both protocols reduce to (ADR-040).
 *
 * A zero is not a measurement of "nothing was used": it is either "this protocol has
 * no such concept" (OpenAI has no cache *write*) or "the vendor did not report it".
 * Only the adapter can tell those apart, so a consumer must not read these numbers as
 * a reconciled bill.
 */
export interface ModelUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/**
 * The kernel compares kinds, never the vendor's vocabulary (ADR-035): `finish_reason`
 * and `stop_reason` are protocol words, and code that branches on them is code that
 * has to be revisited every time a vendor adds one.
 */
export type StopReasonKind = 'end' | 'toolCalls' | 'maxTokens' | 'other';

export interface StopReason {
  readonly kind: StopReasonKind;
  /**
   * The vendor's own value, kept because "why did this stop?" is a question the log
   * has to answer: `finish_reason: 'content_filter'` and `stop_reason: 'refusal'` both
   * land in `other`, and the kind alone cannot say which one happened.
   */
  readonly raw: string;
}

export class ContextOverflowError extends Error {
  override readonly name = 'ContextOverflowError';
}
