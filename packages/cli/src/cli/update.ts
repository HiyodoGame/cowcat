import type { KernelEvent } from '@corescense/cowcat-core';

/**
 * Reading a host update without claiming to know its shape.
 *
 * The protocol deliberately does not re-describe the event body (ADR-055: an additive
 * kernel change must not need the frontend to change), and this verb is a consumer of
 * that same port. So the fields are read by name at the point of use, and an event this
 * build does not know is ignored rather than fatal.
 */
export function field(update: unknown, name: string): unknown {
  return typeof update === 'object' && update !== null ? Reflect.get(update, name) : undefined;
}

export function updateType(update: unknown): string | null {
  const type = field(update, 'type');
  return typeof type === 'string' ? type : null;
}

/** A `turn.transitioned` whose `to` is terminal, as the one-shot verb's completion signal. */
export function isTerminalTransition(update: unknown): boolean {
  if (updateType(update) !== 'turn.transitioned') return false;
  const to = field(update, 'to');
  return to === 'completed' || to === 'failed' || to === 'cancelled';
}

/** Narrows a durable event for the callers that want the log's own fields. */
export function asEvent(update: unknown): KernelEvent | null {
  return updateType(update) !== null && typeof field(update, 'seq') === 'number' ? (update as KernelEvent) : null;
}
