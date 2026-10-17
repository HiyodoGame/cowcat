export { Session, type SessionDeps } from './kernel/session.js';
export {
  assertSupportedSchemaVersion,
  isSupportedSchemaVersion,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  UnsupportedSchemaVersionError,
} from './kernel/schema-version.js';
export { reduce, replay, initialState, type SessionState, type TurnView } from './kernel/state.js';
export { runTurn, type TurnDeps, type TurnOutcome } from './kernel/run-turn.js';
export { canTransition, isTerminal, IllegalTransitionError, type TurnState } from './kernel/turn.js';
export type { KernelEvent, KernelEventType, EventInput, SessionUpdate, StreamDelta } from './kernel/events.js';
export type { Message, ToolCall } from './kernel/messages.js';
export { decide, type ActionRequest, type Decision, type Rule, type Verdict } from './policy/decide.js';
export { DEFAULT_RULES } from './policy/defaults.js';
export {
  LockHeldError,
  type LockPort,
  type SessionLock,
  type SessionSnapshot,
  type SnapshotPort,
  type ToolPort,
  type ToolSpec,
  type ToolResult,
  type ToolRisk,
  type ModelPort,
  type ModelChunk,
  type ModelRequest,
  type EventStore,
  type Clock,
  type IdSource,
} from './ports/index.js';
export {
  defaultSandboxProfile,
  type ProcessPort,
  type ProcessSpec,
  type ProcessResult,
  type TerminationRecord,
  type TerminationReason,
  type TerminationMethod,
  type SandboxMode,
  type SandboxNetwork,
  type SandboxBackend,
  type SandboxProfile,
  type EnvRedactionPolicy,
  type ReadPolicy,
  type WritePolicy,
  type FsPort,
  type FileKind,
  type PathPolicyResolver,
  SandboxUnavailableError,
  SandboxRequestRefusedError,
  type AppliedSandbox,
  type PlatformPort,
  type PlatformId,
  type Shell,
  type SessionShell,
  type ShellKind,
  type SandboxBackendVerdict,
  type TerminationStrategy,
} from './ports/index.js';
export { ENV_ALWAYS_KEEP, ENV_SENSITIVE, redactEnv, type RedactionRequest, type RedactionResult } from './policy/env.js';
export { JsonlEventStore, FileLockPort, FileSnapshotPort, systemClock, randomIds } from './adapters/node.js';
export { NodeFs, nodeFs } from './adapters/fs.js';
export { NodeProcess, type NodeProcessOptions, type SandboxCommand, type SandboxCommandResolver } from './adapters/process.js';
export { buildSandboxCommand, createSandboxExecutor, type ExecutorDeps } from './adapters/sandbox/executor.js';
export {
  buildBwrapCommand,
  BWRAP_READ_PATHS,
  type BwrapCommand,
  type BwrapOptions,
  type SandboxFsProbe,
} from './adapters/sandbox/backends/bwrap.js';
export {
  buildSeatbeltCommand,
  isUnder,
  RUNTIME_ALLOWS,
  SEATBELT_READ_PATHS,
  type SeatbeltCommand,
  type SeatbeltOptions,
} from './adapters/sandbox/backends/seatbelt.js';
export {
  DEFAULT_HOME_READ_ALLOW,
  DEFAULT_READ_DENY,
  DEFAULT_WRITE_DENY,
  SANDBOX_TMPFS_BYTES,
} from './policy/sandbox-defaults.js';
export { expand, isAbsolutePath, resolveEntries, type ResolveRequest, type ResolveResult } from './policy/sandbox-paths.js';
export { noTermination, nodeTreeKiller, terminateTree, type TreeKiller } from './adapters/terminate.js';
export { OutputTail } from './adapters/output-tail.js';
export { NodePlatform, nodePlatform, type NodePlatformOptions } from './adapters/platform.js';
export {
  detectPlatformId,
  discoverWindowsRoots,
  gitRoots,
  posixShellCandidates,
  posixPath,
  resolveShell,
  windowsShellCandidates,
  winPath,
  type PathFlavour,
  type ResolveOptions,
  type RunResult,
  type ShellCandidate,
  type ShellHost,
  type ShellResolution,
} from './adapters/shell.js';
export { probeBackends, usableBackend, WINDOWS_ALTERNATIVES, type ProbeHost } from './adapters/sandbox-probe.js';
