export { Session, type SessionDeps } from './kernel/session.js';
export {
  assertSupportedSchemaVersion,
  isSupportedSchemaVersion,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  UnsupportedSchemaVersionError,
} from './kernel/schema-version.js';
export { reduce, replay, initialState, type SessionState, type TurnView } from './kernel/state.js';
export { runTurn, DEFAULT_APPROVAL_TIMEOUT_MS, type TurnDeps, type TurnNote, type TurnOutcome } from './kernel/run-turn.js';
export { canTransition, isTerminal, IllegalTransitionError, type TurnState } from './kernel/turn.js';
export type { KernelEvent, KernelEventType, EventInput, SessionUpdate, StreamDelta } from './kernel/events.js';
export type { Message, ReasoningBlock, ToolCall } from './kernel/messages.js';
export type { ModelLimits, ModelPreset, ModelProtocol } from './kernel/preset.js';
export {
  decide,
  validateRules,
  type ActionRequest,
  type Decision,
  type Rule,
  type RuleProblem,
  type RuleWhen,
  type Verdict,
} from './policy/decide.js';
export { DEFAULT_RULES } from './policy/defaults.js';
export {
  CONFIG_LAYERS,
  DEFAULT_CONFIG,
  resolveConfig,
  type ConfigLayer,
  type ConfigLayerName,
  type ConfigLayers,
  type CowcatConfig,
  type RuleOrigin,
  type SourcedRule,
} from './policy/config.js';
export { trustedRules, isTrusted, type TrustState } from './policy/trust.js';
export { approvalKey, type ApprovalBy, type ApprovalVerdict } from './policy/approval.js';
export { AuditConsumer, type AuditSummary } from './policy/audit.js';
export { JsonlAuditSink, type JsonlAuditSinkOptions } from './adapters/audit.js';
export { FileTrustStore, extractTrusted, type FileTrustStoreOptions } from './adapters/trust.js';
export { INSTRUCTION_FILENAMES, decideInstruction, describeInstructionSkip, type InstructionDecision } from './policy/instructions.js';
export { FileInstructionSource, type FileInstructionSourceOptions } from './adapters/instructions.js';
export {
  loadConfig,
  type ConfigError,
  type ConfigLoadResult,
  type ConfigSource,
  type ConfigWarning,
} from './adapters/config.js';
export {
  LockHeldError,
  type LockPort,
  type SessionLock,
  type SessionSnapshot,
  type SnapshotPort,
  type ToolPort,
  type ToolSpec,
  type ToolResult,
  type ToolGrant,
  type ToolRisk,
  type Truncation,
  type ModelPort,
  type ModelChunk,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
  type StopReasonKind,
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
  type InstructionFile,
  type InstructionPort,
  type PathPolicyResolver,
  SandboxUnavailableError,
  SandboxRequestRefusedError,
  type AppliedSandbox,
  type AuditRecord,
  type AuditSink,
  type ExecutionFacts,
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
export { buildSandboxCommand, createSandboxExecutor, shellQuote, type ExecutorDeps } from './adapters/sandbox/executor.js';
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
