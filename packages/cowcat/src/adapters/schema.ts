import { z } from 'zod';
import type { KernelEvent } from '../kernel/events.js';

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

export const kernelEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session.opened'),
    schemaVersion: z.number().int().positive(),
    cowcatVersion: z.string(),
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
  z.object({ ...base, type: z.literal('tool.finished'), callId: z.string(), ok: z.boolean(), output: z.string() }),
]);

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
