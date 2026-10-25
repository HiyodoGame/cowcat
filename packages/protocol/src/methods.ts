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
  'session.fork',
  'session.list',
  'turn.send',
  'turn.cancel',
  'model.list',
  'model.set',
  'context.compact',
  'grants.list',
  'grants.revoke',
  'change.undo',
  'change.redo',
  'approval.respond',
  'accept-edits.set',
  'plan.setMode',
  'plan.reply',
  'attachment.read',
  'task.stop',
  /** The `/cron` panel's read side (ADR-143 ②): the live job projection with next runs. */
  'cron.list',
  /** The `/cron` panel's delete side: false when the id is not this session's live job. */
  'cron.remove',
  /** The workspace trust gate's read side (ADR-157 ②): the host's startup snapshot. */
  'trust.status',
  /** Persist the startup cwd into the trust store (ADR-157 ②); no config hot-reload. */
  'trust.grant',
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
  /** Fork a session by replaying its log into a new one (ADR-127). */
  'session.fork': z.strictObject({ sessionId: z.string().min(1) }),
  'session.list': noParams,
  'turn.send': z.strictObject({
    sessionId: z.string().min(1),
    input: z.string(),
    /** `@` file references: absolute paths, validated and read by the host (ADR-128). */
    files: z.array(z.string().min(1)).max(8).optional(),
  }),
  'turn.cancel': z.strictObject({ sessionId: z.string().min(1) }),
  'model.list': z.strictObject({ sessionId: z.string().min(1) }),
  'model.set': z.strictObject({ sessionId: z.string().min(1), preset: z.string().min(1), effort: z.string().min(1).nullable().optional() }),
  'context.compact': z.strictObject({ sessionId: z.string().min(1) }),
  'grants.list': z.strictObject({ sessionId: z.string().min(1) }),
  'grants.revoke': z.strictObject({ sessionId: z.string().min(1), grantId: z.string().regex(/^grant_\d+$/) }),
  'change.undo': z.strictObject({ sessionId: z.string().min(1) }),
  'change.redo': z.strictObject({ sessionId: z.string().min(1) }),
  'approval.respond': z.strictObject({
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    verdict: z.enum(['once', 'always', 'session', 'reject']),
  }),
  /** Toggling accept-edits mode is a user act too (ADR-159 ③), never model-initiated. */
  'accept-edits.set': z.strictObject({ sessionId: z.string().min(1), enabled: z.boolean() }),
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
  // Cron jobs are session-scoped exactly like background tasks (ADR-140): a client may
  // only read or remove ids its own session owns.
  'cron.list': z.strictObject({ sessionId: z.string().min(1) }),
  'cron.remove': z.strictObject({ sessionId: z.string().min(1), jobId: z.string().min(1) }),
  // Trust is asked about the host's own startup cwd (ADR-157), so neither method takes a
  // path: a client cannot ask about — or grant — anywhere else.
  'trust.status': noParams,
  'trust.grant': noParams,
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
  /**
   * Derived, never stored (ADR-126): the first turn's prompt, clipped; the creation
   * directory and initial model from the session header. All absent on sessions written
   * before these existed — the same additive rule as `parentSessionId`.
   */
  /** Why it has a parent (ADR-127 ④): absent when there is no parent. */
  readonly parentRole?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly model?: string;
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
  readonly 'session.open': SessionSummary & {
    readonly replayed: number;
    /** The session's summed usage, when the log has billed anything (ADR-131 ①). */
    readonly usage?: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheCreation: number;
    };
  };
  readonly 'session.create': SessionSummary;
  /** The forked session's new id (ADR-127). */
  readonly 'session.fork': { readonly sessionId: string };
  readonly 'session.list': { readonly sessions: readonly SessionSummary[] };
  readonly 'turn.send': { readonly turnId: string; readonly queued?: boolean };
  readonly 'turn.cancel': { readonly cancelled: boolean };
  readonly 'model.list': ModelListResult;
  readonly 'model.set': { readonly current: ModelSelectionSummary };
  readonly 'context.compact': { readonly compacted: boolean; readonly dropped: number; readonly reason: string | null };
  readonly 'grants.list': { readonly grants: readonly GrantSummary[] };
  readonly 'grants.revoke': { readonly revoked: boolean };
  readonly 'change.undo': { readonly path: string };
  readonly 'change.redo': { readonly path: string };
  readonly 'approval.respond': { readonly accepted: boolean };
  readonly 'accept-edits.set': { readonly enabled: boolean };
  readonly 'plan.setMode': { readonly enabled: boolean };
  readonly 'plan.reply': { readonly accepted: boolean };
  readonly 'attachment.read': AttachmentBytes;
  /** False when the task is already gone (finished, or never belonged to this session). */
  readonly 'task.stop': { readonly stopped: boolean };
  /** One scheduled job as the `/cron` panel needs it (ADR-143 ②). */
  readonly 'cron.list': { readonly jobs: readonly CronJobSummary[] };
  /** False when the id is not this session's live job; the deletion event is the truth. */
  readonly 'cron.remove': { readonly removed: boolean };
  /** The startup snapshot (ADR-157 ②): what trusting this workspace would unlock. */
  readonly 'trust.status': { readonly trusted: boolean; readonly withheld: TrustWithheld };
  readonly 'trust.grant': { readonly granted: true };
  readonly shutdown: { readonly closing: true };
}

/** What the project layer is holding back from an untrusted workspace (ADR-157 ②). */
export interface TrustWithheld {
  /** Project `allow` rules that trust would admit (ADR-028). */
  readonly rules: number;
  /** AGENTS.md/CLAUDE.md files whose injection trust would allow (ADR-030/077). */
  readonly instructions: number;
  /** Project skills skipped by the trust gate (ADR-114). */
  readonly skills: number;
  /** Project-scoped MCP servers (ADR-083~). */
  readonly mcpServers: number;
  /** Project hook files skipped by the trust gate (ADR-121). */
  readonly hooks: number;
}

export interface GrantSummary {
  readonly id: string;
  readonly key: string;
  readonly verdict: 'always' | 'session';
}

export interface ModelSummary {
  readonly id: string;
  readonly efforts: readonly string[];
}

export interface ModelSelectionSummary {
  readonly id: string;
  readonly effort: string | null;
}

export interface ModelListResult {
  readonly current: ModelSelectionSummary;
  readonly models: readonly ModelSummary[];
}

/** A cron job as it crosses the wire: the log's facts plus the derived next fire. */
export interface CronJobSummary {
  readonly jobId: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  /** Next SCHEDULED fire in ms — a long turn delays the actual run (ADR-141 ⑦). */
  readonly nextRun: number | null;
  readonly lastFiredAt: number | null;
}

export type Result<M extends MethodName> = ResultTable[M];

export function isMethodName(value: string): value is MethodName {
  return (METHODS as readonly string[]).includes(value);
}
