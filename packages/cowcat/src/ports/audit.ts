import type { AppliedSandbox, TerminationRecord } from './process.js';

/**
 * One line of the audit trail: everything known about a single tool call, joined
 * from the events already in the log (ADR-033).
 *
 * It is a PROJECTION, not a copy. The log already holds the decision, the approval
 * and the result; repeating them verbatim would give one fact two homes that can
 * disagree. What this adds is the join — `policy.decided` + `approval.answered` +
 * `tool.finished` become one row — plus the runtime facts that only the executing
 * tool can report.
 *
 * `sandbox` is `null` when the tool reported no facts at all. That is deliberately
 * NOT the same as a sandbox of mode `off`: an audit that conflates "nothing was
 * applied" with "nobody said" cannot answer the only question it exists to answer.
 */
export interface AuditRecord {
  readonly sessionId: string;
  readonly turnId: string | null;
  /** The `tool.finished` sequence number that completed this record. */
  readonly seq: number;
  readonly ts: number;
  readonly callId: string;
  readonly tool: string;
  readonly verdict: string;
  readonly rule: string;
  readonly approval: { readonly verdict: string; readonly by: string } | null;
  readonly ok: boolean;
  /** null means NOT REPORTED, not "no sandbox". */
  readonly sandbox: AppliedSandbox | null;
  readonly termination: TerminationRecord | null;
  readonly removedEnv: readonly string[];
  readonly ignoredDeny: readonly string[];
}

/** Where audit rows go. Writing is the sink's problem; failing is the consumer's. */
export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}
