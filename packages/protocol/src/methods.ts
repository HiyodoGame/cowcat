import { z } from 'zod';

/**
 * The method table, as data (the same rule ADR-060 sets for the CLI subcommands).
 *
 * Params are schemas, not hand-written types: the schema is what the server validates
 * against, so deriving the type from it keeps the two from drifting. Results are typed
 * in `results` below and are *not* re-validated at runtime — see `index.ts` for the
 * reason (the `initialize` handshake is what makes them safe to trust).
 */
export const METHODS = [
  'initialize',
  'session.open',
  'session.create',
  'session.list',
  'turn.send',
  'turn.cancel',
  'approval.respond',
  'plan.setMode',
  'plan.reply',
  'attachment.read',
  'task.stop',
  'shutdown',
] as const;

export type MethodName = (typeof METHODS)[number];

const noParams = z.strictObject({});

export const PARAMS = {
  initialize: z.strictObject({
    /** The client's protocol generation. A mismatch is a handshake failure, not a
     *  negotiation: ADR-016's discipline is to refuse, never to degrade. */
    protocolVersion: z.number().int(),
  }),
  'session.open': z.strictObject({ sessionId: z.string().min(1) }),
  /** `sessionId` is optional so the server can mint one; minting needs an id source,
   *  which lives in the host, not here. */
  'session.create': z.strictObject({ sessionId: z.string().min(1).optional() }),
  'session.list': noParams,
  'turn.send': z.strictObject({ sessionId: z.string().min(1), input: z.string() }),
  'turn.cancel': z.strictObject({ sessionId: z.string().min(1) }),
  'approval.respond': z.strictObject({
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    verdict: z.enum(['once', 'always', 'session', 'reject']),
  }),
  /** Toggling plan mode is a user act (ADR-124 ⑥): the switch never comes from the model. */
  'plan.setMode': z.strictObject({
    sessionId: z.string().min(1),
    enabled: z.boolean(),
  }),
  /** The answer to a plan review (ADR-125 ③): the chosen plan's index, or none with a reason. */
  'plan.reply': z
    .strictObject({
      sessionId: z.string().min(1),
      callId: z.string().min(1),
      choice: z.number().int().min(0).nullable(),
      reason: z.string().nullable(),
    })
    // A chosen plan carries no reason; a rejection carries no index. One shape per
    // answer keeps the host from silently dropping a field (review of #167, P2-13).
    .refine((value) => value.choice === null || value.reason === null, {
      message: 'reason must be null when choice is set',
    }),
  'attachment.read': z.strictObject({
    id: z.string().min(1),
    /** The caller's own cap. The host still enforces its own limit; the smaller one
     *  wins, and exceeding either is a refusal (`attachmentTooLarge`), never a
     *  truncation (ADR-057: bytes are not silently clipped). */
    maxBytes: z.number().int().positive().optional(),
  }),
  // A background task is stopped by id, within the session that owns it (ADR-113): the
  // host refuses ids that belong to another session rather than letting one client kill
  // another's work.
  'task.stop': z.strictObject({ sessionId: z.string().min(1), taskId: z.string().min(1) }),
  shutdown: noParams,
} satisfies Record<MethodName, z.ZodType>;

export type Params<M extends MethodName> = z.infer<(typeof PARAMS)[M]>;

export type ApprovalVerdict = Params<'approval.respond'>['verdict'];

export interface SessionSummary {
  readonly sessionId: string;
  readonly lastSeq: number;
  /**
   * The session that delegated this one (ADR-079 ③), absent for a top-level session.
   *
   * Additive: a client that ignores it lists children as if they were top-level, which is
   * what every client did before delegation existed.
   */
  readonly parentSessionId?: string;
}

export interface AttachmentBytes {
  readonly id: string;
  readonly mediaType: string;
  readonly byteLength: number;
  /**
   * Base64, no `data:` prefix. Bytes travel the transport but never enter the session
   * log (ADR-057: the log holds references, the disk holds bytes).
   */
  readonly data: string;
}

export interface ResultTable {
  readonly initialize: { readonly protocolVersion: number; readonly serverVersion: string };
  /**
   * `replayed` counts the log lines that follow this response as `event`
   * notifications, oldest first: the client rebuilds its screen by applying them, so
   * it never needs a second way to ask "what does the session look like now"
   * (ADR-059 ②: same log → same screen).
   */
  readonly 'session.open': SessionSummary & { readonly replayed: number };
  readonly 'session.create': SessionSummary;
  readonly 'session.list': { readonly sessions: readonly SessionSummary[] };
  readonly 'turn.send': { readonly turnId: string };
  readonly 'turn.cancel': { readonly cancelled: boolean };
  readonly 'approval.respond': { readonly accepted: boolean };
  readonly 'plan.setMode': { readonly enabled: boolean };
  readonly 'plan.reply': { readonly accepted: boolean };
  readonly 'attachment.read': AttachmentBytes;
  /** False when the task is already gone (finished, or never belonged to this session). */
  readonly 'task.stop': { readonly stopped: boolean };
  readonly shutdown: { readonly closing: true };
}

export type Result<M extends MethodName> = ResultTable[M];

export function isMethodName(value: string): value is MethodName {
  return (METHODS as readonly string[]).includes(value);
}
