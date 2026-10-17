// ProcessPort — the single gateway every child process goes through (ADR-014).
//
// Why a gateway at all: the legacy agent spawned children from nine places (bash
// tool, background tasks, MCP stdio, hooks, statusline, TUI shell mode, git, the
// sandbox probe, the CLI's own --background re-exec) and had THREE different
// termination behaviours. Everything outside the two that had it either left
// orphans or killed only the direct child. `research/p2-ports.md` §2.1 has the
// table; this file is the fix, expressed as one interface.
//
// This module is types only. The rules encoded here are not aspirations — each
// one is a measured boundary from research/p2-ports.md appendix B:
//
//   * Windows has no process groups. `taskkill /T /F` walks the parent→child
//     relation, so it MUST be called while the direct child is still alive: once
//     the parent is gone it exits 128 ("no process found") and the tree is
//     unreachable forever (measured). Therefore terminate() is one call, never
//     "kill the child, then tree-kill".
//   * POSIX has process groups. A descendant that calls setsid() escapes
//     kill(-pgid) and, once its parent dies, cannot even be found by walking
//     ppid (measured). The port therefore documents the boundary instead of
//     implying it can kill everything. What the platform CAN do arrives from
//     PlatformPort as `TerminationStrategy`; what a run actually did is a
//     `TerminationMethod`.
//   * Windows SIGTERM is not catchable (measured): there is no graceful window,
//     so there is nothing to escalate from.
//
// Env redaction, output truncation and process-tree termination all happen INSIDE
// the port (ADR-015): the caller says what it wants, the gateway decides what the
// child actually sees.

/** The three isolation tiers. `system` is refused where no backend exists (ADR-016). */
export type SandboxMode = 'off' | 'light' | 'system';

export type SandboxNetwork = 'off' | 'ask' | 'on';

/**
 * Backend selection. `auto` lets the platform pick from what it reports usable;
 * naming one explicitly fails loudly when it is unusable rather than falling back
 * (the legacy failure mode this replaces).
 */
export type SandboxBackend = 'auto' | 'bwrap' | 'seatbelt' | 'none';

/**
 * Credential-shaped environment variables to strip, on top of the built-in rule
 * set. Each entry is an exact name (case-insensitive) or a `/regex/` string — the
 * legacy syntax, kept so existing configuration keeps working (ADR-015).
 */
export interface EnvRedactionPolicy {
  readonly deny: readonly string[];
}

/**
 * Read policy. `workspace` binds only what is allowed, so a denied path is
 * unreachable rather than merely unread; `hide` opens reads and removes the denied
 * paths, kept as the escape hatch for toolchains that need a path we cannot
 * enumerate. Literal paths only — a glob is collected as unsupported and
 * surfaced, never silently dropped (research/p2-ports.md §3.1 item 9).
 */
export interface ReadPolicy {
  readonly profile: 'workspace' | 'hide';
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/** Write policy is allow-only: "anything not granted is denied" is the shape that does not rot. */
export interface WritePolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * The resolved, backend-agnostic policy a run executes under. Paths are already
 * canonical (ADR-017): seatbelt matches `(subpath …)` against the path the kernel
 * reports, so `/var/...` in write.allow would grant nothing for `/private/var/...`.
 */
export interface SandboxProfile {
  readonly mode: SandboxMode;
  readonly backend: SandboxBackend;
  readonly network: SandboxNetwork;
  readonly env: EnvRedactionPolicy;
  readonly read: ReadPolicy;
  readonly write: WritePolicy;
  /** Rules the active backend cannot express. Surfaced, never silently ignored. */
  readonly limitations: readonly string[];
}

/**
 * What to run. `env` is what the CALLER wants; the gateway redacts it per the
 * profile before the child sees anything (ADR-015), so a caller can never
 * accidentally hand over an unredacted environment by assembling env itself.
 */
export interface ProcessSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Written once, then stdin is closed. Omitted means no stdin. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Characters kept per stream. The tail is kept, with the dropped count reported. */
  readonly outputCap?: number;
  readonly sandbox: SandboxProfile;
}

/** Why the port was asked to terminate. Recorded so a run's ending is reconstructable. */
export type TerminationReason = 'timeout' | 'cancel' | 'shutdown' | 'none';

/**
 * What was actually done to the tree on this run. Distinct from the platform's
 * `TerminationStrategy` (which says what the platform CAN do): a record can say
 * `single-process` because the tree strategy was unavailable, and `none` because
 * the child exited on its own before anyone asked.
 */
export type TerminationMethod = 'process-group' | 'taskkill-tree' | 'single-process' | 'none';

/**
 * The termination record. `residuePossible` exists because "we asked and it did
 * not answer" is not the same as "it is gone": a fallback to a single-process
 * kill may leave descendants running, and that has to reach the caller and the
 * audit rather than be reported as a clean kill (ADR-014).
 */
export interface TerminationRecord {
  readonly requested: boolean;
  readonly reason: TerminationReason;
  readonly strategy: TerminationMethod;
  /** The grace period expired, so SIGKILL (or /F) was used. */
  readonly escalated: boolean;
  /** The tree strategy was unavailable and only the direct child was signalled. */
  readonly fallbackUsed: boolean;
  /** Termination could not be proven; descendants may still be running. */
  readonly residuePossible: boolean;
}

/**
 * The parts of a `ProcessResult` worth persisting to the session log (ADR-033).
 *
 * A subset on purpose. `stdout` / `stderr` / `exitCode` describe the OUTCOME, and
 * the outcome already reaches the log as `tool.finished.ok` + `.output`. What is
 * nowhere else — and what nobody can reconstruct afterwards — is what the gateway
 * actually DID: which sandbox ran, how the process ended, and which variables were
 * taken out of its environment.
 *
 * This type exists because `ToolPort.run` returns a `ToolResult`, not a
 * `ProcessResult`: without it the sandbox facts stop at the tool boundary and an
 * audit consumer can never see them.
 */
export interface ExecutionFacts {
  readonly sandbox: AppliedSandbox;
  readonly termination: TerminationRecord;
  /** Names only, never values (ADR-015). */
  readonly removedEnv: readonly string[];
  readonly ignoredDeny: readonly string[];
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when either stream hit the cap. The result says so instead of the caller guessing. */
  readonly truncated: boolean;
  /**
   * Characters dropped from the FRONT of each stream, so "the tail you see" can be
   * accounted for. Structured rather than an in-band `[truncated]` marker: the caller
   * knows who is reading this output and can render the notice in the words that
   * reader needs, and one fact should not have two renderings.
   */
  readonly dropped: { readonly stdout: number; readonly stderr: number };
  /**
   * Names the gateway stripped from the child's environment. Names only — a stripped
   * variable's value is exactly the thing that must not travel further (ADR-015).
   */
  readonly removedEnv: readonly string[];
  /** Deny entries that were not usable, e.g. an invalid `/regex/`. Surfaced, never dropped. */
  readonly ignoredDeny: readonly string[];
  /**
   * What the gateway ACTUALLY applied, not what was asked for. An audit that records
   * the requested mode cannot answer "was this run really sandboxed?", which is the
   * only question anyone asks afterwards (03-policy-and-execution.md, failure-mode
   * principle 2). `backend` is null when the request was refused — and a refusal
   * never becomes a silent downgrade (ADR-016).
   */
  readonly sandbox: AppliedSandbox;
  readonly termination: TerminationRecord;
}

export interface AppliedSandbox {
  readonly mode: SandboxMode;
  readonly backend: SandboxBackend | null;
  /** Rules the backend could not express, plus the ones it was configured to accept. Surfaced, never dropped. */
  readonly limitations: readonly string[];
}

export interface ProcessPort {
  /**
   * Runs one child to completion. `signal` aborts it, and aborting follows the
   * same path as a timeout — one terminate(), not two (ADR-014).
   *
   * Rejects only when the child could not be STARTED, or when the requested
   * sandbox mode is unavailable on this platform. Once started, the run resolves:
   * a non-zero exit, a signal and a failed termination are results, not errors,
   * because the caller has to report all three to the model.
   */
  run(spec: ProcessSpec, signal: AbortSignal): Promise<ProcessResult>;
}

/** Convenience: the profile a run gets when nothing is configured. `light` is the default tier. */
export function defaultSandboxProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    mode: 'light',
    backend: 'auto',
    network: 'off',
    env: { deny: [] },
    read: { profile: 'workspace', allow: [], deny: [] },
    write: { allow: [], deny: [] },
    limitations: [],
    ...overrides,
  };
}