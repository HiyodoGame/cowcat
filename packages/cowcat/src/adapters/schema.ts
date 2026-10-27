import { z } from 'zod';
import type { KernelEvent } from '../kernel/events.js';
import type { SessionSnapshot } from '../ports/index.js';

// Decoding lives in the adapter layer, next to the store that needs it: the kernel
// works on typed events and must not know how bytes became them (ADR-009).
//
// Every object here is deliberately open — zod strips unknown keys instead of
// rejecting them. A log written by a newer build that only added fields therefore
// still decodes, and is then judged by `schemaVersion` rather than by a confusing
// "unexpected key" error (ADR-012). For the same reason `schemaVersion` is a plain
// positive integer: `z.literal(1)` would report a v2 log as a field mismatch.

const turnStateSchema = z.enum([
  'idle',
  'requesting',
  'streaming',
  'awaiting_tools',
  'awaiting_approval',
  'finishing',
  'completed',
  'cancelled',
  'failed',
]);

const verdictSchema = z.enum(['allow', 'ask', 'deny']);

const approvalVerdictSchema = z.enum(['once', 'always', 'session', 'reject']);
// `policy` is reachable here even though it is not one of the two answers a person
// can give: it is what a standing `always` from earlier in the same session records
// when it lets a later call through (ADR-031).
const approvalBySchema = z.enum(['user', 'policy', 'timeout', 'unattended']);

// The gateway's own account of what it did (ADR-033). Mirrors ports/process.ts; the
// compile-time assertion in test/schema.test.ts holds the two together through
// `KernelEvent`.
const appliedSandboxSchema = z.object({
  mode: z.enum(['off', 'light', 'system']),
  backend: z.enum(['auto', 'bwrap', 'seatbelt', 'none']).nullable(),
  limitations: z.readonly(z.array(z.string())),
});

const terminationRecordSchema = z.object({
  requested: z.boolean(),
  reason: z.enum(['timeout', 'cancel', 'shutdown', 'none']),
  strategy: z.enum(['process-group', 'taskkill-tree', 'single-process', 'none']),
  escalated: z.boolean(),
  fallbackUsed: z.boolean(),
  residuePossible: z.boolean(),
});

const executionFactsSchema = z.object({
  sandbox: appliedSandboxSchema,
  termination: terminationRecordSchema,
  removedEnv: z.readonly(z.array(z.string())),
  ignoredDeny: z.readonly(z.array(z.string())),
});

const toolCallSchema = z.object({
  callId: z.string(),
  name: z.string(),
  input: z.unknown(),
});

// Mirrors `Truncation` in ports/index.ts (ADR-048). `dropped` is the amount missing, so
// it can never be negative, and `reason` names the unit it counts in.
const truncationSchema = z.object({
  truncated: z.boolean(),
  // Nullable for the same reason `ToolResult.truncation` is absent rather than zero:
  // "stopped early, total unknown" is a different fact from "dropped nothing" (ADR-053).
  dropped: z.number().int().nonnegative().nullable(),
  reason: z.string().nullable(),
});

// A field added after schemaVersion 1 was already being written by dev builds
// (ADR-048/049). Absent decodes to `null`, which is the same statement a present `null`
// makes: "nothing reported". Plain `.optional()` would infer `undefined`, and
// `exactOptionalPropertyTypes` makes that a different type from the kernel's.
const nullableFromAbsent = <T extends z.ZodType>(schema: T): z.ZodType<z.output<T> | null> =>
  schema
    .nullish()
    .transform((value: z.output<T> | null | undefined): z.output<T> | null => value ?? null);

const attachmentSchema = z.object({
  type: z.enum(['image', 'document']),
  mediaType: z.string().min(1),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  // Absent-and-null are the same statement here, as everywhere else in this file.
  width: nullableFromAbsent(z.number().int().positive()),
  height: nullableFromAbsent(z.number().int().positive()),
  pages: nullableFromAbsent(z.number().int().positive()),
});

// Mirrors `ReasoningBlock` in kernel/messages.ts (ADR-045). Both arms carry an opaque
// vendor token — `signature` for readable thinking, `data` for a redacted block — and
// the kernel never looks inside either one.
const reasoningBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), text: z.string(), signature: z.string() }),
  z.object({ type: z.literal('redacted'), data: z.string() }),
]);

const decisionSchema = z.object({
  verdict: verdictSchema,
  rule: z.string(),
  reason: z.string().nullable(),
});

// Mirrors the vocabulary in ports/model.ts. The compile-time assertion in
// test/schema.test.ts holds the two descriptions together through `KernelEvent`
// (ADR-035, ADR-040).
const modelUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
});

// Mirrors `TodoItem` in ports/index.ts (ADR-054). The status is an enum here for the
// same reason the tool's input schema uses one: a status the kernel cannot interpret
// must not reach the log.
const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1),
});

const stopReasonSchema = z.object({
  kind: z.enum(['end', 'toolCalls', 'maxTokens', 'other']),
  raw: z.string(),
});

const base = {
  seq: z.number().int().positive(),
  ts: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  turnId: z.string().nullable(),
};

// The shell a session's commands ran through: a durable fact, so required rather than
// optional. That does not conflict with the "open objects" rule above, which is about
// a NEWER build meeting an OLD log's extra keys — the opposite direction. This field
// only appears in schemaVersion 1 because version 1 has never been released (the
// package is `private: 0.0.0`), so no existing log is missing it; changing the
// required header fields from here on means bumping schemaVersion (ADR-012).
const sessionShellSchema = z.object({
  kind: z.enum(['posix', 'git-bash', 'powershell', 'cmd']),
  executable: z.string(),
});

export const kernelEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session.opened'),
    schemaVersion: z.number().int().positive(),
    cowcatVersion: z.string(),
    shell: sessionShellSchema,
    // Added with delegation (ADR-079 ③); absent means a top-level session, which is what
    // every log written before this field existed says.
    parent: z.object({ sessionId: z.string(), role: z.enum(['explore', 'general', 'fork']) }).optional(),
    // Added with ADR-126; absent means "not recorded" on every older log, same rule.
    cwd: z.string().optional(),
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('turn.opened'),
    input: z.string(),
    model: z.string().optional(),
    // ADR-105: the window the turn ran under, when the preset declares one. Absent is the
    // shape of every log written before this field existed.
    contextWindow: z.number().int().positive().optional(),
    // The meter's price source (ADR-131). Optional: no price, no cost line.
    price: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative().optional(),
        cacheCreation: z.number().nonnegative().optional(),
      })
      .optional(),
  }),
  z.object({
    ...base,
    type: z.literal('turn.transitioned'),
    from: turnStateSchema,
    to: turnStateSchema,
    reason: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('turn.noted'),
    // The list is duplicated from `TurnNoteKind` on purpose: this is the wire contract,
    // and the kernel's union is what it is checked against (the `Equals` assertion below).
    note: z.enum(['tools-unsupported', 'effort-not-declared', 'compaction-failed', 'instructions-skipped', 'skills-skipped', 'rounds-exhausted', 'hook-failed', 'queue-failed']),
    message: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('model.message'),
    text: z.string(),
    toolCalls: z.readonly(z.array(toolCallSchema)),
    reasoning: z.readonly(z.array(reasoningBlockSchema)),
    // Nullable rather than optional, for the same reason as `tool.finished.facts`:
    // `null` says "the adapter reported nothing" out loud (ADR-035).
    stopReason: stopReasonSchema.nullable(),
    invocation: z.string().min(1).optional(),
  }),
  z.object({ ...base, type: z.literal('model.usage'), usage: modelUsageSchema, invocation: z.string().min(1).optional() }),
  z.object({
    ...base,
    type: z.literal('context.compacted'),
    trigger: z.enum(['auto', 'manual', 'overflow']),
    summary: z.string(),
    throughSeq: z.number().int().nonnegative(),
    shadowed: z.readonly(z.array(z.number().int().positive())),
    dropped: z.number().int().nonnegative(),
    model: z.string(),
    usage: modelUsageSchema.nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('context.compaction.started'),
    trigger: z.enum(['auto', 'manual', 'overflow']),
    model: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('context.compaction.finished'),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('instructions.loaded'),
    trigger: z.enum(['start', 'refresh']),
    text: z.string(),
    files: z.readonly(z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() }))),
  }),
  z.object({
    ...base,
    type: z.literal('skills.loaded'),
    trigger: z.enum(['start', 'refresh']),
    text: z.string(),
    skills: z.readonly(
      z.array(
        z.object({
          name: z.string(),
          layer: z.enum(['user', 'project']),
          origin: z.enum(['cowcat', 'claude']),
          bytes: z.number().int().nonnegative(),
        }),
      ),
    ),
  }),
  z.object({ ...base, type: z.literal('policy.decided'), callId: z.string(), decision: decisionSchema }),
  z.object({ ...base, type: z.literal('todo.updated'), todos: z.readonly(z.array(todoItemSchema)) }),
  z.object({
    ...base,
    type: z.literal('approval.requested'),
    callId: z.string(),
    name: z.string(),
    rule: z.string(),
    reason: z.string().nullable(),
    // Optional, not nullable: a log written before ADR-095 has no opinion to record.
    warning: z.string().optional(),
    // The exact subject under review (ADR-129 7). Optional for the same reason: older
    // logs asked without recording it.
    command: z.string().optional(),
    path: z.string().optional(),
    dimensions: z.readonly(z.array(z.enum(['deny-override', 'unsandboxed']))).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.answered'),
    callId: z.string(),
    key: z.string(),
    verdict: approvalVerdictSchema,
    by: approvalBySchema,
  }),
  z.object({
    ...base,
    type: z.literal('approval.revoked'),
    key: z.string(),
    by: z.literal('user'),
  }),
  z.object({
    ...base,
    type: z.literal('escalation.granted'),
    callId: z.string(),
    key: z.string(),
    scope: z.enum(['once', 'always']),
    dimension: z.enum(['deny-override', 'unsandboxed']),
  }),
  z.object({
    ...base,
    type: z.literal('escalation.consumed'),
    callId: z.string(),
    key: z.string(),
    dimension: z.enum(['deny-override', 'unsandboxed']),
  }),
  z.object({
    ...base,
    type: z.literal('file.changed'),
    callId: z.string(),
    path: z.string(),
    beforePath: z.string(),
    created: z.boolean(),
    beforeHash: z.string().nullable().optional(),
    afterHash: z.string().nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('file.reverted'),
    callId: z.string(),
    path: z.string(),
    redoPath: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('file.restored'),
    callId: z.string(),
    path: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.finished'),
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    output: z.string(),
    // Nullable rather than optional, for two reasons: it holds the same shape as
    // `turnId` and `reason`, and `exactOptionalPropertyTypes` makes an optional field
    // here mean "absent or undefined" while the type means "absent, never undefined".
    // `null` says "the tool reported nothing" out loud.
    facts: executionFactsSchema.nullable(),
    // Added after dev logs already existed (ADR-048/049), hence absent-tolerating.
    truncation: nullableFromAbsent(truncationSchema),
    path: nullableFromAbsent(z.string()),
    // Same for attachments (ADR-057): a log written before this field existed decodes to
    // `null`, which says "the tool reported nothing" rather than "it produced no image".
    attachments: nullableFromAbsent(z.readonly(z.array(attachmentSchema))),
  }),
  z.object({
    ...base,
    type: z.literal('tool.repeat-detected'),
    callId: z.string(),
    name: z.string(),
    count: z.number().int().min(2),
    text: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('hooks.context-added'),
    text: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('prompt.attached'),
    files: z.readonly(z.array(z.readonly(z.object({ name: z.string(), content: z.string() })))),
  }),
  z.object({
    ...base,
    type: z.literal('plan.mode-changed'),
    enabled: z.boolean(),
    by: z.enum(['user', 'plan-approved']),
  }),
  z.object({
    ...base,
    type: z.literal('accept-edits.mode-changed'),
    enabled: z.boolean(),
    by: z.literal('user'),
  }),
  z.object({
    ...base,
    type: z.literal('plan.proposed'),
    callId: z.string(),
    plans: z.readonly(z.array(z.readonly(z.object({ title: z.string(), summary: z.string() })))),
  }),
  z.object({
    ...base,
    type: z.literal('plan.decided'),
    callId: z.string(),
    choice: z.number().int().nullable(),
    reason: z.string().nullable(),
  }),
  // ADR-111: the pair that makes a background task auditable. Both are plain objects with no
  // absent-tolerance needed: no log predates them, and the registry always knows the fields.
  z.object({
    ...base,
    type: z.literal('tool.background.started'),
    callId: z.string(),
    taskId: z.string(),
    command: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.background.finished'),
    callId: z.string(),
    taskId: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    state: z.enum(['exited', 'stopped', 'lost']),
    reason: z.enum(['timeout', 'cancel', 'shutdown', 'none']),
    // `facts` is always present but may be null (a lost exit never produced a result), the
    // same statement `tool.finished.facts` makes.
    facts: executionFactsSchema.nullable(),
    tail: z.string(),
    truncated: z.boolean(),
    dropped: z.number().int().nonnegative(),
  }),
  // ADR-140: the cron triple. The job table is a projection of these (see the
  // events' own comments); no log predates them, so no absent-tolerance is needed.
  z.object({
    ...base,
    type: z.literal('cron.created'),
    jobId: z.string(),
    schedule: z.string(),
    prompt: z.string(),
    recurring: z.boolean(),
    createdAt: z.number(),
    expiresAt: z.number().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('cron.deleted'),
    jobId: z.string(),
    by: z.enum(['user', 'model', 'expiry']),
    deletedAt: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal('cron.fired'),
    jobId: z.string(),
    turnId: z.string(),
    firedAt: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal('subagent.started'),
    callId: z.string(),
    childSessionId: z.string(),
    role: z.enum(['explore', 'general']),
    description: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('subagent.finished'),
    callId: z.string(),
    childSessionId: z.string(),
    role: z.enum(['explore', 'general']),
    ok: z.boolean(),
    state: z.enum(['completed', 'failed', 'cancelled']),
    turns: z.number().int().nonnegative(),
    partial: z.boolean(),
    usage: modelUsageSchema.nullable(),
    reason: z.string().nullable(),
  }),
]);

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string() }),
  z.object({
    role: z.literal('assistant'),
    text: z.string(),
    toolCalls: z.readonly(z.array(toolCallSchema)),
    reasoning: z.readonly(z.array(reasoningBlockSchema)),
  }),
  z.object({
    role: z.literal('tool'),
    callId: z.string(),
    ok: z.boolean(),
    output: z.string(),
    // A snapshot written before ADR-057 has tool messages without this field, and the
    // kernel's message type says "required, possibly empty" — so absent becomes empty
    // here. The *event* keeps the distinction (null = the tool reported nothing); a
    // message only has to say what it carries.
    attachments: z
      .readonly(z.array(attachmentSchema))
      .nullish()
      .transform((value) => value ?? []),
  }),
]);

const turnViewSchema = z.object({ id: z.string(), state: turnStateSchema });

const sessionStateSchema = z.object({
  sessionId: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  turn: turnViewSchema.nullable(),
  messages: z.readonly(z.array(messageSchema)),
  // The seq each message came from (ADR-071). Same length as `messages`; a snapshot that
  // disagrees is not a state we understand, and a snapshot missing the field replays.
  messageSeqs: z.readonly(z.array(z.number().int().positive())),
  // The provider's last report and where it ended (ADR-070). `null` until one arrives,
  // and reset by every compaction.
  lastUsage: z
    .object({
      tokens: z.number().int().nonnegative(),
      anchorSeq: z.number().int().nonnegative().nullable(),
      invocation: z.string().min(1).optional(),
      usage: modelUsageSchema.optional(),
    })
    .nullable(),
  usageTotals: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheCreation: z.number().int().nonnegative(),
  }),
  // The compaction lock (ADR-072). A snapshot written mid-compaction keeps it open, which
  // is exactly what the log says too.
  compactionOpen: z.boolean(),
  // Plan mode (ADR-124). Same lifecycle as the fields below: a snapshot written before
  // the field existed fails validation and the caller replays instead (ADR-013).
  planMode: z.boolean(),
  acceptEdits: z.boolean(),
  // The instruction message currently in `messages` (ADR-078), and how many were injected.
  instructionsSeq: z.number().int().positive().nullable(),
  instructionsCount: z.number().int().nonnegative(),
  // The skill catalog message currently in `messages` (ADR-116 ④). Same lifecycle as the
  // instruction message: a snapshot written before the field existed fails validation and
  // the caller replays instead (ADR-013).
  skillsSeq: z.number().int().positive().nullable(),
  skillsCount: z.number().int().nonnegative(),
  // The `always` answers this session has given. Part of the state, not a side
  // table, so a snapshot that dropped them would silently re-ask questions the user
  // already answered.
  grants: z.readonly(z.array(z.string())),
  // Refusals that stand for the session (ADR-129 5), approved appeals and the `once`
  // grants already spent. Same lifecycle as `grants`: a snapshot written before these
  // fields existed fails validation and the caller replays instead (ADR-013) — which is
  // the documented answer to a snapshot we cannot fully understand, and re-deriving
  // from the log is exactly what replay does.
  refused: z.readonly(z.array(z.string())),
  escalations: z.readonly(
    z.array(z.object({ key: z.string(), scope: z.enum(['once', 'always']), dimension: z.enum(['deny-override', 'unsandboxed']) })),
  ),
  escalationsConsumed: z.readonly(z.array(z.string())),
  // Derived from `tool.finished` (ADR-049). A snapshot is an accelerator: one written
  // before this field existed fails validation and the caller replays instead, which is
  // the documented answer to "a snapshot we cannot fully understand" (ADR-013).
  readFiles: z.readonly(z.array(z.string())),
  // Replaced wholesale by each `todo.updated` (ADR-054). Like `readFiles`, a snapshot
  // written before the field existed fails validation and the caller replays instead.
  todos: z.readonly(z.array(todoItemSchema)),
});

// A snapshot is derived data, so it gets the same rigour as the log it accelerates:
// a half-understood state would be *silently* wrong, and a wrong session state is far
// worse than a slow one.
export const sessionSnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  lastSeq: z.number().int().nonnegative(),
  state: sessionStateSchema,
});

// A snapshot that cannot be understood is treated exactly like one that is absent: the
// caller replays instead, so this resolves to null rather than throwing. Two invariants
// are cheap enough to check and fatal enough to matter — the state must belong to the
// requested session, and the envelope must agree with the state it carries.
export function decodeSnapshot(raw: string, sessionId: string): SessionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const decoded = sessionSnapshotSchema.safeParse(parsed);
  if (!decoded.success) return null;

  const snapshot = decoded.data;
  if (snapshot.state.sessionId !== sessionId) return null;
  if (snapshot.state.lastSeq !== snapshot.lastSeq) return null;
  return snapshot;
}

// `toolCalls[0].callId` rather than `toolCalls.0.callId`: the field path is part of
// the reported error, so it is worth rendering for a human (P1 exit standard).
function pathOf(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out.length === 0 ? String(segment) : `.${String(segment)}`;
  }
  return out.length === 0 ? '<root>' : out;
}

export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`).join('; ');
}

// `where` is the caller's location label (`sess.jsonl at line 3`), so file and line
// knowledge stays with the store that owns the file.
export function decodeEventLine(line: string, where: string): KernelEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`corrupt session log ${where}: not valid JSON`);
  }
  const decoded = kernelEventSchema.safeParse(parsed);
  if (!decoded.success) {
    throw new Error(`corrupt session log ${where}: ${describeIssues(decoded.error)}`);
  }
  return decoded.data;
}
