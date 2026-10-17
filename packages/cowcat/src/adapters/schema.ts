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

const approvalVerdictSchema = z.enum(['once', 'always', 'reject']);

// `policy` is reachable here even though it is not one of the two answers a person
// can give: it is what a standing `always` from earlier in the same session records
// when it lets a later call through (ADR-031).
const approvalBySchema = z.enum(['user', 'policy', 'timeout']);

const toolCallSchema = z.object({
  callId: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const decisionSchema = z.object({
  verdict: verdictSchema,
  rule: z.string(),
  reason: z.string().nullable(),
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
  }),
  z.object({ ...base, type: z.literal('turn.opened'), input: z.string() }),
  z.object({
    ...base,
    type: z.literal('turn.transitioned'),
    from: turnStateSchema,
    to: turnStateSchema,
    reason: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('model.message'),
    text: z.string(),
    toolCalls: z.readonly(z.array(toolCallSchema)),
  }),
  z.object({ ...base, type: z.literal('policy.decided'), callId: z.string(), decision: decisionSchema }),
  z.object({
    ...base,
    type: z.literal('approval.requested'),
    callId: z.string(),
    name: z.string(),
    rule: z.string(),
    reason: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.answered'),
    callId: z.string(),
    key: z.string(),
    verdict: approvalVerdictSchema,
    by: approvalBySchema,
  }),
  z.object({ ...base, type: z.literal('tool.finished'), callId: z.string(), ok: z.boolean(), output: z.string() }),
]);

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string() }),
  z.object({
    role: z.literal('assistant'),
    text: z.string(),
    toolCalls: z.readonly(z.array(toolCallSchema)),
  }),
  z.object({ role: z.literal('tool'), callId: z.string(), ok: z.boolean(), output: z.string() }),
]);

const turnViewSchema = z.object({ id: z.string(), state: turnStateSchema });

const sessionStateSchema = z.object({
  sessionId: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  turn: turnViewSchema.nullable(),
  messages: z.readonly(z.array(messageSchema)),
  // The `always` answers this session has given. Part of the state, not a side
  // table, so a snapshot that dropped them would silently re-ask questions the user
  // already answered.
  grants: z.readonly(z.array(z.string())),
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
