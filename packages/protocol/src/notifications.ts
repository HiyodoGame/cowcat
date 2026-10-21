import { z } from 'zod';

/**
 * Server-to-client notifications (ADR-055). The three are distinguished on purpose:
 *
 *   event  a durable fact (a `KernelEvent`) — it is in the log, and replaying it
 *          reproduces the screen (ADR-059 ②)
 *   delta  a streamed token, live rendering only; never persisted, never state
 *   log    the server's own diagnostics — not a session fact, so it must not be
 *          mistaken for one by a client that stores what it receives
 */
export const NOTIFICATIONS = {
  event: 'event',
  delta: 'delta',
  log: 'log',
} as const;

export type NotificationName = (typeof NOTIFICATIONS)[keyof typeof NOTIFICATIONS];

/**
 * The event envelope, validated strictly, with the body passed through.
 *
 * That asymmetry is the whole decision: `seq`/`ts`/`sessionId`/`turnId`/`type` are the
 * fields every consumer reads and the ones a reordering or a version skew shows up in,
 * while the body belongs to the kernel's event union. Re-describing that union here
 * would be a second hand-written copy of `packages/cowcat/src/adapters/schema.ts` — the
 * exact drift the kernel already spends a compile-time equivalence assertion on — and
 * it would break on any *additive* kernel change, which is the change we most want to
 * survive: `tool.finished` grew `truncation`, `path` and (T5) `attachments` without the
 * protocol needing to care.
 *
 * A consequence worth stating: `type` is a plain string, so an event this version does
 * not know decodes fine and the renderer decides what to do with it. That is the
 * graceful path; failing the decode would turn a newer kernel into a dead frontend.
 */
export const eventParamsSchema = z.looseObject({
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  sessionId: z.string().min(1),
  turnId: z.string().nullable(),
  type: z.string().min(1),
});

/** `StreamDelta`/`ReasoningDelta` as they cross the wire. Fields are the ones a renderer
 *  appends text with; like the event body they are passed through, so a later field (a
 *  reasoning index, a token count) reaches the renderer instead of being rejected here. */
export const deltaParamsSchema = z.looseObject({
  type: z.enum(['model.delta', 'reasoning.delta']),
  turnId: z.string().min(1),
  text: z.string(),
});

export const logParamsSchema = z.strictObject({
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  data: z.unknown().optional(),
});

export type WireEvent = z.infer<typeof eventParamsSchema>;
export type WireDelta = z.infer<typeof deltaParamsSchema>;
export type WireLog = z.infer<typeof logParamsSchema>;

export const NOTIFICATION_SCHEMAS = {
  event: eventParamsSchema,
  delta: deltaParamsSchema,
  log: logParamsSchema,
} satisfies Record<NotificationName, z.ZodType>;

export type NotificationParams = {
  readonly event: WireEvent;
  readonly delta: WireDelta;
  readonly log: WireLog;
};

export function isNotificationName(value: string): value is NotificationName {
  return (Object.values(NOTIFICATIONS) as readonly string[]).includes(value);
}

export interface ParsedNotification {
  readonly name: NotificationName;
  readonly params: unknown;
}

/**
 * Decode one line as a notification, or report that it is not one.
 *
 * Both callers need this: the client (to fan out to its subscribers) and a
 * transport-only consumer such as a log recorder. It returns `null` for anything that
 * is not a well-formed notification of a known name — including a response, which
 * shares the transport.
 */
export function parseNotification(line: string): ParsedNotification | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const method: unknown = Reflect.get(value, 'method');
  if (typeof method !== 'string' || !isNotificationName(method)) return null;
  const parsed = NOTIFICATION_SCHEMAS[method].safeParse(Reflect.get(value, 'params'));
  if (!parsed.success) return null;
  return { name: method, params: parsed.data };
}

/**
 * The envelope the server checks before it sends. A host handing back something that is
 * not an event is a programming error in the composition root, and it is worth failing
 * at this boundary rather than putting it on the wire (the client would then have to
 * decide what an unrecognisable fact means).
 */
export function isWireEvent(value: unknown): value is WireEvent {
  return eventParamsSchema.safeParse(value).success;
}
