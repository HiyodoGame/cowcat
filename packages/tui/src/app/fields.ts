/**
 * Reading a field off an update, without claiming to know its shape.
 *
 * The protocol deliberately does NOT re-describe the event body (ADR-055): it validates the
 * envelope (`seq`/`ts`/`sessionId`/`turnId`/`type`) and passes the rest through, so that an
 * additive kernel change — `tool.finished` grew `truncation`, `path` and `attachments` —
 * does not require the frontend to change. The consequence is this file: the renderer reads
 * the fields it knows by name, at the point of use, and an event it does not know is
 * displayed as "unsupported" rather than crashing on a missing field.
 *
 * Every reader returns `null`/empty rather than throwing. A frontend that dies because a
 * field it never read went away is a frontend that turns a cosmetic difference into a
 * blank screen.
 */
export function read(update: unknown, name: string): unknown {
  return typeof update === 'object' && update !== null ? Reflect.get(update, name) : undefined;
}

export function text(update: unknown, name: string): string | null {
  const value = read(update, name);
  return typeof value === 'string' ? value : null;
}

export function number(update: unknown, name: string): number | null {
  const value = read(update, name);
  return typeof value === 'number' ? value : null;
}

export function flag(update: unknown, name: string): boolean | null {
  const value = read(update, name);
  return typeof value === 'boolean' ? value : null;
}

/** A nested object, or `null` when the field is absent or not an object. */
export function record(update: unknown, name: string): Record<string, unknown> | null {
  const value = read(update, name);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An array of objects, skipping entries that are not objects. */
export function records(update: unknown, name: string): readonly Record<string, unknown>[] {
  const value = read(update, name);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

/** The event envelope's type, which every event has. */
export function updateType(update: unknown): string | null {
  return text(update, 'type');
}

/**
 * The event's `seq`, which is also its identity: one event produces at most one transcript
 * entry, so the log's own numbering is the key a renderer needs — and two renders of the
 * same log produce the same keys, which is what makes a frame snapshot comparable.
 */
export function updateSeq(update: unknown): number | null {
  return number(update, 'seq');
}
