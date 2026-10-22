import {
  AttachmentTooLargeError,
  ERROR_CODES,
  NoSuchSessionError,
  ProtocolHostError,
  type ApprovalVerdict,
  type AttachedSession,
  type AttachmentBytes,
  type ProtocolHost,
  type SessionSummary,
} from '@corescense/cowcat-protocol';
import { join } from 'node:path';
import { createBashTool } from '../adapters/tools/bash.js';
import type { SpillConfig } from '../adapters/spill.js';
import { createEditTool } from '../adapters/tools/edit.js';
import { createGlobTool } from '../adapters/tools/glob.js';
import { createGrepTool } from '../adapters/tools/grep.js';
import { createReadTool } from '../adapters/tools/read.js';
import { createTodoWriteTool } from '../adapters/tools/todo.js';
import { createWriteTool } from '../adapters/tools/write.js';
import { NodeBackgroundTasks } from '../adapters/background.js';
import { AttachmentUnavailableError, materializeAttachment } from '../adapters/attachments.js';
import { FileLockPort, FileSnapshotPort, JsonlEventStore, randomIds, systemClock } from '../adapters/node.js';
import { NodeFs } from '../adapters/fs.js';
import { NodePlatform } from '../adapters/platform.js';
import { NodeProcess } from '../adapters/process.js';
import { createSandboxExecutor } from '../adapters/sandbox/executor.js';
import { fsProbeFrom } from '../adapters/sandbox/fs-probe.js';
import { createSessionIndex } from '../adapters/session-index.js';
import { startMcpServers } from '../adapters/mcp/servers.js';
import { FileTrustStore } from '../adapters/trust.js';
import { FileInstructionSource } from '../adapters/instructions.js';
import { FileSkills } from '../adapters/skills.js';
import { createHooksPort, loadHookSources } from '../adapters/hooks.js';
import { createSkillTool } from '../adapters/tools/skill.js';
import { GLOBAL_INSTRUCTION_FILENAME } from '../policy/instructions.js';
import { projectRootOf } from '../adapters/instructions.js';
import { decideSkills } from '../policy/skills.js';
import { Session, type SessionDeps } from '../kernel/session.js';
import { runTurn, type TurnDeps } from '../kernel/run-turn.js';
import type { KernelEvent, SessionUpdate } from '../kernel/events.js';
import { trustedRules, isTrusted } from '../policy/trust.js';
import { resolveSandboxProfile, type ResolvedSandboxProfile } from '../policy/sandbox-profile.js';
import type { CowcatConfig } from '../policy/config.js';
import type { ActionRequest, Rule } from '../policy/decide.js';
import {
  ATTACHMENT_HARD_LIMIT_BYTES,
  LockHeldError,
  type Attachment,
  type Clock,
  type BackgroundExit,
  type BackgroundTasksPort,
  type EventStore,
  type FsPort,
  type IdSource,
  type LockPort,
  type ModelPort,
  type PlatformPort,
  type ProcessPort,
  type SnapshotPort,
  type SkillFile,
  type SkillPort,
  type SubagentOutcome,
  type SubagentRequest,
  type ToolPort,
  type ModelUsage,
} from '../ports/index.js';
import { ModelConfigError, createModelPort, selectModel, type ModelSelection } from './model.js';
import { loadHostConfig, selectMcpServers, withHostRules } from './config.js';
import { cowcatPaths, type CowcatPaths } from './paths.js';
import { rulesForRole, toolsForRole } from './subagent-roles.js';
import type { ConfigFileReader, ReadTextFile } from '../adapters/config-files.js';

// The composition root (ADR-062 ②, ADR-064): the one place that assembles the kernel,
// the adapters and the protocol host port, and the only place in `packages/cowcat` that
// knows a frontend exists.
//
// Everything the kernel needs is already a port; what is decided here, and nowhere else,
// is WHICH implementations, pointed at which paths, and with what rules. Three
// decisions worth reading before the code:
//
//   1. Config is loaded once, at construction, and a file that cannot be read or decoded
//      refuses the whole host rather than degrading to defaults. `createHost` is async
//      for exactly this reason: refusing at startup is fixable, refusing mid-turn is not.
//   2. The MODEL is not. `selectModel`/`createModelPort` run on the first `turn.send`, so
//      a machine with no model configured can still list sessions, read a log, or run
//      `doctor` — and so a missing key is reported to the frontend as a refusal with an
//      error code instead of killing the process at startup.
//   3. Approvals pair on the call id from the request itself, not from a log event:
//      `ActionRequest.callId` is the same id `approval.requested` carries, and taking it
//      from the value in hand removes the ordering question entirely.

export class HostConfigError extends Error {
  /** One line per problem, ready to print. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the configuration cannot be used:\n${problems.join('\n')}`);
    this.name = 'HostConfigError';
    this.problems = problems;
  }
}

export interface CreateHostOptions {
  /** The session's working directory: where tools resolve relative paths. */
  readonly cwd: string;
  /** The USER's home directory. Used for `~` in policy entries. */
  readonly home: string;
  /**
   * The process environment, passed in rather than read.
   *
   * It is the only source of a model API key (ADR-063 D3), and this layer may not touch
   * the host runtime — which also makes "the key is missing" a case a test can describe.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The build's version, recorded in the session header (ADR-012). */
  readonly version?: string;
  /** The session config layer: `--config <path>`, when the caller named one. */
  readonly configPath?: string | null;
  readonly paths?: CowcatPaths;
  readonly readFiles?: ConfigFileReader;
  readonly readTextFile?: ReadTextFile;
  readonly fs?: FsPort;
  /** Injected so a test can describe skills without a real home directory (ADR-114). */
  readonly skills?: SkillPort;
  readonly platform?: PlatformPort;
  readonly process?: ProcessPort;
  readonly store?: EventStore;
  readonly lock?: LockPort;
  readonly snapshots?: SnapshotPort;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly trustStore?: { load(): Promise<{ readonly trusted: readonly string[]; readonly problem: string | null }> };
  /** A model for tests. When absent it is built from the config on the first turn. */
  readonly model?: ModelPort;
  /** Injected so a test can assert the endpoint without a network (ADR-042). */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * True for a verb with nobody watching (`cowcat run`). Background tasks are refused there:
   * a process that outlives the command and has no interface to stop it is how v1 hung CI
   * (ADR-112).
   */
  readonly unattended?: boolean;
  readonly approvalTimeoutMs?: number;
}

/**
 * The protocol host, plus the two things the protocol has no verb for.
 *
 * `close()` exists because a kernel `Session` holds the session lock for its whole life
 * (ADR-010): a host that never released it would leave a lock file behind and the next
 * process would report "writer pid … is gone but left its lock file behind".
 */
export interface CowcatHost extends ProtocolHost {
  readonly paths: CowcatPaths;
  readonly config: CowcatConfig;
  /** The rules a session runs with, in force order. */
  readonly rules: readonly Rule[];
  readonly sandbox: ResolvedSandboxProfile;
  /** Non-fatal findings from the config layers, for whatever reports them. */
  readonly configWarnings: readonly string[];
  close(): Promise<void>;
}

const MAX_EARLY_APPROVALS = 8;

interface PendingApproval {
  readonly callId: string;
  readonly resolve: (verdict: ApprovalVerdict) => void;
}

interface SessionRecord {
  readonly session: Session;
  readonly listeners: Set<(update: unknown) => void>;
  unsubscribe: () => void;
  lastSeq: number;
  /** Resolved by the `turn.opened` the host sees, so `turn.send` can answer early. */
  turnWaiters: Array<(turnId: string) => void>;
  pendingApproval: PendingApproval | null;
  /**
   * Answers that arrived before the kernel reached the bridge (ADR-065 ② is instant;
   * the event is emitted before `approve()` is called). Holding them by call id is what
   * keeps a fast `run --yes` from losing its own answer to the event/subscribe seam.
   */
  readonly earlyApprovals: Map<string, ApprovalVerdict>;
  running: { readonly controller: AbortController; readonly done: Promise<void> } | null;
}

export async function createHost(options: CreateHostOptions): Promise<CowcatHost> {
  const paths = options.paths ?? cowcatPaths({ cwd: options.cwd, home: options.home });

  const loaded = await loadHostConfig({
    cwd: options.cwd,
    home: options.home,
    sessionConfigPath: options.configPath ?? null,
    paths,
    ...(options.readFiles === undefined ? {} : { readFiles: options.readFiles }),
    ...(options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile }),
  });
  if (!loaded.ok) throw new HostConfigError(loaded.errors.map((error) => `${error.source}: ${error.problem}`));

  const config = loaded.config;
  const fs = options.fs ?? new NodeFs();
  const version = options.version ?? '0.0.0';

  // Trust is a statement about the workspace (ADR-028), so it is read here and applied
  // to the rules: without this, a repository's own `cowcat.json` could hand itself
  // permissions the user never granted.
  const trustStore =
    options.trustStore ?? new FileTrustStore({ file: paths.trustFile, fs });
  const trust = await trustStore.load();
  // Whether this workspace is trusted gates two things: its own rules (ADR-028) and
  // whether its instructions are injected at all (ADR-030/077).
  const workspaceTrusted = isTrusted(trust.trusted, options.cwd, fs);
  const rules = withHostRules(trustedRules(config, { trusted: workspaceTrusted }));

  const platform = options.platform ?? new NodePlatform({ env: options.env });
  const sandbox = resolveSandboxProfile(config.sandbox, { cwd: options.cwd, home: options.home, fs });
  const processes =
    options.process ??
    new NodeProcess({
      platform,
      sandboxCommand: createSandboxExecutor({ platform, fsProbe: fsProbeFrom(fs) }),
    });

  const warnings: string[] = loaded.warnings.map((warning) => `${warning.source}: ${warning.problem}`);
  const background = new NodeBackgroundTasks({ process: processes });

  // Skills (ADR-114). Discovery is host work; precedence and the trust gate are decided in
  // policy from the same `workspaceTrusted` value the rules and instructions use.
  const skillsPort = options.skills ?? new FileSkills({ fs, home: options.home });
  const skillDiscovery = await skillsPort.discover(options.cwd);
  warnings.push(...skillDiscovery.warnings);
  const skillDecision = decideSkills(skillDiscovery.skills, { trusted: workspaceTrusted });
  if (skillDecision.kind === 'injected') {
    for (const shadowed of skillDecision.shadowed) {
      warnings.push(`skill "${shadowed.name}": ${shadowed.loser.path} is shadowed by ${shadowed.winner.path}`);
    }
  }
  const availableSkills = skillDecision.kind === 'injected' ? skillDecision.skills : [];

  // Hooks (ADR-121/123). User-configured scripts at lifecycle points, Claude Code
  // settings.json compatible. Project sources are trusted-gated exactly like MCP
  // servers and skills; the trust snapshot is the host's, taken here at startup.
  const projectRoot = projectRootOf(fs, options.cwd);
  const hookSources = await loadHookSources({
    home: options.home,
    cowcatDir: paths.dir,
    projectRoot,
    trusted: workspaceTrusted,
  });
  if (hookSources.skippedUntrusted > 0) {
    warnings.push(`hooks: skipped ${String(hookSources.skippedUntrusted)} project file(s) from an untrusted workspace (cowcat trust 后再生效)`);
  }
  const hooksPort = createHooksPort({
    parsed: hookSources.parsed,
    process: processes,
    platform,
    sandbox: sandbox.profile,
    projectDir: projectRoot ?? options.cwd,
    sessionsDir: paths.sessionsDir,
  });

  const builtinTools = createTools({
    cwd: options.cwd,
    platform,
    process: processes,
    sandbox: sandbox.profile,
    background,
    allowBackground: options.unattended !== true,
    skills: availableSkills,
    spill: { rootDir: paths.sessionsDir },
  });

  // MCP servers (ADR-083~087). Project entries are executable entry points, so the same
  // trust gate that guards their rules guards them; every skip is reported.
  const selected = selectMcpServers(config.mcp, { trusted: workspaceTrusted });
  warnings.push(...selected.warnings);

  const mcpLifetime = new AbortController();
  const mcp = await startMcpServers({
    servers: selected.servers,
    cwd: options.cwd,
    env: options.env,
    sandbox: sandbox.profile,
    process: processes,
    version,
    baseTools: builtinTools,
    warn: (message) => {
      warnings.push(message);
    },
    signal: mcpLifetime.signal,
  });
  const tools: ReadonlyMap<string, ToolPort> = mcp.table;
  /**
   * Child sessions are not in `sessions`, so their background exits could not be routed
   * back to the child log (ADR-111 ⑤). Rather than leave a task nobody can account for,
   * children get a Bash without the registry and the tool's own refusal.
   */
  const subagentTools = new Map(tools);
  subagentTools.set(
    'Bash',
    createBashTool({
      cwd: options.cwd,
      platform,
      process: processes,
      sandbox: sandbox.profile,
      spill: { rootDir: paths.sessionsDir },
    }),
  );
  const store = options.store ?? new JsonlEventStore(paths.sessionsDir);
  const sessionDeps: SessionDeps = {
    store,
    clock: options.clock ?? systemClock,
    ids: options.ids ?? randomIds,
    lock: options.lock ?? new FileLockPort(paths.sessionsDir),
    snapshots: options.snapshots ?? new FileSnapshotPort(paths.sessionsDir),
    cowcatVersion: version,
    shell: platform.resolveShell(),
  };
  const index = createSessionIndex(paths.sessionsDir);
  const sessions = new Map<string, SessionRecord>();
  /**
   * Background tasks that ended before their `started` event was written (ADR-111). A task
   * can finish while the turn is still recording that it began; the exit waits here until
   * the log says the task existed, so replay never sees an end without a beginning.
   */
  const pendingBackgroundExits = new Map<string, BackgroundExit>();
  const startedBackground = new Set<string>();
  const backgroundWrites = new Set<Promise<void>>();
  /** Every attachment this host has seen in a log, by path (ADR-057: `id` is the path). */
  const attachments = new Map<string, Attachment>();

  let selection: ModelSelection | null = null;
  let model: ModelPort | null = options.model ?? null;

  // The model is built from the config, so a config problem becomes a refusal the
  // frontend can read instead of a stack trace it cannot (see the header, note 2).
  function currentModel(): { readonly port: ModelPort; readonly selection: ModelSelection } {
    try {
      selection ??= selectModel(config.model);
      model ??= createModelPort(selection, options.env, options.fetch === undefined ? {} : { fetch: options.fetch });
      return { port: model, selection };
    } catch (error) {
      if (error instanceof ModelConfigError) {
        throw new ProtocolHostError(
          error.hint === null ? error.message : `${error.message} — ${error.hint}`,
          ERROR_CODES.hostRefused,
          { problem: error.problem },
        );
      }
      throw error;
    }
  }

  /**
   * Runs one delegated task (ADR-079/080/081/082).
   *
   * A child is a real session — its own log, its own lock, its own turn — so a failure in
   * it cannot corrupt the parent's history. Everything a child may NOT have is expressed
   * by what this function passes: no `subagents` (so no `Task`, depth 0), no `TodoWrite`,
   * a role tool subset, narrowed rules, and `unattended` so an approval question cannot
   * hang a session nobody is watching.
   */
  async function spawnSubagent(request: SubagentRequest, signal: AbortSignal): Promise<SubagentOutcome> {
    const configured = currentModel();
    const child = await Session.create(sessionDeps, request.sessionId, {
      parent: { sessionId: request.parentSessionId, role: request.role },
    });
    try {
      const childDeps: TurnDeps = {
        session: child,
        model: configured.port,
        preset: configured.selection.preset,
        ...(configured.selection.effort === null ? {} : { effort: configured.selection.effort }),
        tools: toolsForRole(subagentTools, request.role),
        rules: rulesForRole(rules, subagentTools, request.role),
        fs,
        // Never consulted: `unattended` refuses every ask before the bridge is reached.
        approve: () => Promise.resolve('reject'),
        ids: sessionDeps.ids,
        maxRounds: request.maxTurns,
        unattended: 'sub agents cannot ask a human; report what you needed instead',
        // The same chain the parent got: same workspace, same trust (ADR-082 ④).
        instructions: {
          port: new FileInstructionSource({ fs }),
          cwd: options.cwd,
          trust: { trusted: workspaceTrusted },
          global: join(paths.dir, GLOBAL_INSTRUCTION_FILENAME),
        },
      };
      const outcome = await runTurn(childDeps, request.prompt, signal);
      return {
        sessionId: request.sessionId,
        role: request.role,
        state: outcome.state,
        report: finalReport(child),
        turns: child.state.messages.filter((message) => message.role === 'assistant').length,
        partial: outcome.partial,
        usage: await summedUsage(request.sessionId),
        reason: outcome.reason,
      };
    } finally {
      // The child's lock lives for its whole life (ADR-010); leaving it held would make the
      // session unopenable from another process.
      await child.close();
    }
  }

  /** The child's own `model.usage` events, summed (ADR-082 ③: kept out of the parent). */
  async function summedUsage(sessionId: string): Promise<ModelUsage | null> {
    const events = await store.readAll(sessionId);
    const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let seen = false;
    for (const event of events) {
      if (event.type !== 'model.usage') continue;
      seen = true;
      total.input += event.usage.input;
      total.output += event.usage.output;
      total.cacheRead += event.usage.cacheRead;
      total.cacheCreation += event.usage.cacheCreation;
    }
    return seen ? total : null;
  }

  /** The child's last assistant text, which is the report the parent gets. */
  function finalReport(child: Session): string {
    const last = [...child.state.messages].reverse().find((message) => message.role === 'assistant');
    return last?.text ?? '';
  }

  function deliver(rec: SessionRecord, update: SessionUpdate): void {
    // Ephemeral updates have no seq and change no state: they go straight to the listeners
    // (ADR-108 added the third one).
    if (update.type === 'model.delta' || update.type === 'reasoning.delta' || update.type === 'tool.output.delta') {
      for (const listener of rec.listeners) listener(update);
      return;
    }
    rec.lastSeq = update.seq;
    if (update.type === 'turn.opened' && update.turnId !== null) {
      const { turnId } = update;
      const waiters = rec.turnWaiters;
      rec.turnWaiters = [];
      for (const waiter of waiters) waiter(turnId);
    } else if (update.type === 'tool.finished' && update.attachments !== null) {
      for (const attachment of update.attachments) attachments.set(attachment.path, attachment);
    } else if (update.type === 'tool.background.started') {
      startedBackground.add(update.taskId);
      const buffered = pendingBackgroundExits.get(update.taskId);
      if (buffered !== undefined) {
        pendingBackgroundExits.delete(update.taskId);
        startedBackground.delete(update.taskId);
        queueBackgroundFinish(rec, buffered);
      }
    }
    for (const listener of rec.listeners) listener(update);
  }

  /**
   * The registry's word for how a task ended is the only thing that can make it durable.
   * Failures are swallowed: a session closed while its task was ending must not take the
   * host down, and the registry's own record is already gone by then.
   */
  function queueBackgroundFinish(rec: SessionRecord, exit: BackgroundExit): void {
    const write = rec.session
      .backgroundFinished({
        callId: exit.callId,
        taskId: exit.taskId,
        exitCode: exit.exitCode,
        signal: exit.signal,
        state: exit.state,
        reason: exit.reason,
        facts: exit.facts,
        tail: exit.tail,
        truncated: exit.truncated,
        dropped: exit.dropped,
      })
      .catch(() => undefined)
      .finally(() => {
        backgroundWrites.delete(write);
      });
    backgroundWrites.add(write);
  }

  background.onExit((exit) => {
    const rec = sessions.get(exit.sessionId);
    if (rec === undefined) return;
    if (!startedBackground.has(exit.taskId)) {
      pendingBackgroundExits.set(exit.taskId, exit);
      return;
    }
    startedBackground.delete(exit.taskId);
    queueBackgroundFinish(rec, exit);
  });

  function observe(events: readonly KernelEvent[]): void {
    for (const event of events) {
      if (event.type === 'tool.finished' && event.attachments !== null) {
        for (const attachment of event.attachments) attachments.set(attachment.path, attachment);
      }
    }
  }

  function adopt(session: Session): SessionRecord {
    const rec: SessionRecord = {
      session,
      listeners: new Set(),
      unsubscribe: () => undefined,
      lastSeq: session.state.lastSeq,
      turnWaiters: [],
      pendingApproval: null,
      earlyApprovals: new Map(),
      running: null,
    };
    rec.unsubscribe = session.subscribe((update) => {
      deliver(rec, update);
    });
    return rec;
  }

  function lockedError(sessionId: string, error: LockHeldError): ProtocolHostError {
    return new ProtocolHostError(
      `session ${sessionId} is already open in another process: ${error.guidance}`,
      ERROR_CODES.hostRefused,
      { sessionId, pid: error.pid, lockPath: error.lockPath },
    );
  }

  async function record(sessionId: string): Promise<SessionRecord> {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    try {
      const rec = adopt(await Session.open(sessionDeps, sessionId));
      sessions.set(sessionId, rec);
      return rec;
    } catch (error) {
      if (error instanceof LockHeldError) throw lockedError(sessionId, error);
      // "No such session" is a different fact from "this log is unreadable", and the
      // protocol has a code for the first one. An empty log is how the store reports a
      // file that is not there (it does not invent an error for absence).
      const known = await store.readAll(sessionId).catch(() => null);
      if (known !== null && known.length === 0) throw new NoSuchSessionError(sessionId);
      throw new ProtocolHostError(`${sessionId}: ${message(error)}`, ERROR_CODES.hostRefused, { sessionId });
    }
  }

  /** The open session, or a refusal — for the verbs that must not open one implicitly. */
  function open(sessionId: string): SessionRecord {
    const rec = sessions.get(sessionId);
    if (rec === undefined) throw new NoSuchSessionError(sessionId);
    return rec;
  }

  return {
    serverVersion: version,
    paths,
    config,
    rules,
    sandbox,
    configWarnings: warnings,

    async listSessions(): Promise<readonly SessionSummary[]> {
      const entries = await index.list();
      // The parent link travels with the summary so a client can fold children out of its
      // own view (ADR-079 ④): the host lists what is on disk, the frontend decides what to
      // show.
      return entries.map((entry) => ({
        sessionId: entry.sessionId,
        lastSeq: entry.lastSeq,
        ...(entry.parentSessionId === null ? {} : { parentSessionId: entry.parentSessionId }),
      }));
    },

    async createSession(sessionId: string | null): Promise<SessionSummary> {
      const id = sessionId ?? sessionDeps.ids.next('sess');
      if (sessions.has(id)) {
        throw new ProtocolHostError(`session already exists: ${id}`, ERROR_CODES.hostRefused, { sessionId: id });
      }
      let session: Session;
      try {
        session = await Session.create(sessionDeps, id);
      } catch (error) {
        if (error instanceof LockHeldError) throw lockedError(id, error);
        throw new ProtocolHostError(`${id}: ${message(error)}`, ERROR_CODES.hostRefused, { sessionId: id });
      }
      const rec = adopt(session);
      sessions.set(id, rec);
      // SessionStart (ADR-122 ①): fires once per session creation — resume reopens a
      // log and fires nothing, matching the log's own shape (session.opened exists,
      // re-open does not). Failure cannot reject creation: a broken start hook must
      // not keep a session from existing.
      hooksPort
        .run({ event: 'session-start', sessionId: id, cwd: options.cwd }, new AbortController().signal)
        .then((report) => {
          for (const failure of report.failures) {
            warnings.push(`hooks: session-start 失败：${failure}`);
          }
        })
        .catch(() => undefined);
      return { sessionId: id, lastSeq: rec.lastSeq };
    },

    async attach(sessionId: string): Promise<AttachedSession> {
      const rec = await record(sessionId);
      // Subscribe BEFORE reading the log, and hold what arrives until the server has sent
      // the replay: a host that reads first leaves a gap no client can detect, and one
      // that forwards immediately would put a later event before the replay it is part
      // of. The buffer closes the gap; the microtask keeps the order (the server sends
      // its reply and the replay in the same synchronous block, before this runs).
      const buffered: SessionUpdate[] = [];
      let live: ((update: unknown) => void) | null = null;
      const onUpdate = (update: unknown): void => {
        if (live === null) buffered.push(update as SessionUpdate);
        else live(update);
      };
      rec.listeners.add(onUpdate);

      let replay: readonly KernelEvent[];
      try {
        replay = await store.readAll(sessionId);
      } catch (error) {
        rec.listeners.delete(onUpdate);
        throw new ProtocolHostError(`${sessionId}: ${message(error)}`, ERROR_CODES.hostRefused, { sessionId });
      }
      observe(replay);
      const lastSeq = replay.at(-1)?.seq ?? rec.session.state.lastSeq;
      rec.lastSeq = lastSeq;

      return {
        lastSeq,
        replay,
        subscribe: (listener: (update: unknown) => void) => {
          const queued = buffered.filter((update) => {
            if (update.type === 'model.delta' || update.type === 'reasoning.delta' || update.type === 'tool.output.delta') {
              return true;
            }
            return update.seq > lastSeq;
          });
          buffered.length = 0;
          live = listener;
          let subscribed = true;
          queueMicrotask(() => {
            if (!subscribed) return;
            for (const update of queued) listener(update);
          });
          return () => {
            subscribed = false;
            live = null;
            rec.listeners.delete(onUpdate);
          };
        },
      };
    },

    async sendTurn(sessionId: string, input: string): Promise<{ turnId: string }> {
      const rec = await record(sessionId);
      if (rec.running !== null) {
        throw new ProtocolHostError(`session ${sessionId} already has a turn running`, ERROR_CODES.hostRefused, {
          sessionId,
        });
      }
      // Before anything is opened: an unconfigured model is a refusal with a hint, not a
      // turn that starts and fails a moment later.
      const configured = currentModel();
      const controller = new AbortController();
      const opened = new Promise<string>((resolve) => {
        rec.turnWaiters.push(resolve);
      });

      const deps: TurnDeps = {
        session: rec.session,
        model: configured.port,
        preset: configured.selection.preset,
        ...(configured.selection.effort === null ? {} : { effort: configured.selection.effort }),
        tools,
        rules,
        fs,
        approve: (request: ActionRequest) => askApproval(rec, request),
        ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
        ids: sessionDeps.ids,
        // The chain is read per turn but injected once (ADR-078): the fold decides
        // whether it is still in `messages`, so a compaction puts it back.
        instructions: {
          port: new FileInstructionSource({ fs }),
          cwd: options.cwd,
          trust: { trusted: workspaceTrusted },
          global: join(paths.dir, GLOBAL_INSTRUCTION_FILENAME),
        },
        // Skills are top-level only for the same reason delegation is: a child gets a
        // narrowed tool subset, and a catalog naming a tool it cannot call is a lie.
        // The snapshot comes from the host's own discovery, so the catalog and the
        // Skill tool always describe the same set (no hot reload, ADR-114 ⑥).
        skills: {
          skills: skillDiscovery.skills,
          trust: { trusted: workspaceTrusted },
          ...(configured.selection.preset.limits.context === undefined
            ? {}
            : { window: configured.selection.preset.limits.context }),
        },
        // Delegation is available to a top-level session only: the child's deps are built
        // without this field, which is what makes depth 0 the default (ADR-081 ④).
        subagents: { port: { spawn: spawnSubagent } },
        // Hooks ride top-level turns for the same reason delegation does (ADR-121).
        hooks: { port: hooksPort, cwd: options.cwd },
      };

      let failure: unknown = null;
      const done = runTurn(deps, input, controller.signal).then(
        () => undefined,
        (error: unknown) => {
          failure = error;
        },
      );
      const settled = done.then(() => undefined);
      rec.running = { controller, done: settled };
      void settled.then(() => {
        rec.running = null;
        rec.pendingApproval = null;
        // An answer for a call that never reached the bridge must not outlive the turn.
        rec.earlyApprovals.clear();
        rec.turnWaiters = [];
      });
      // RACE, not all: the reply has to go out while the turn is still running, and the
      // answer is the id the session reported when it opened the turn. If the turn ends
      // first the id is still there — a session keeps its last turn — so a turn that
      // opens and completes in one go answers correctly too.
      await Promise.race([settled, opened]);
      const turnId = rec.session.turnId;
      if (turnId === null) {
        throw new ProtocolHostError(
          `the turn ended before it opened: ${message(failure ?? new Error('no turn was opened'))}`,
          ERROR_CODES.hostRefused,
          { sessionId },
        );
      }
      return { turnId };
    },

    async cancelTurn(sessionId: string): Promise<void> {
      const rec = open(sessionId);
      const running = rec.running;
      if (running === null) return;
      running.controller.abort();
      await running.done;
    },

    async stopTask(sessionId: string, taskId: string): Promise<boolean> {
      // Opening validates the session; a task id from another session must not be
      // stoppable from here, so the ownership check is on the registry record, not on
      // the caller's word (ADR-113).
      open(sessionId);
      const task = background.list().find((info) => info.taskId === taskId);
      if (task === undefined || task.sessionId !== sessionId) return false;
      return background.stop(taskId);
    },

    respondApproval(sessionId: string, callId: string, verdict: ApprovalVerdict): Promise<void> {
      const rec = open(sessionId);
      const pending = rec.pendingApproval;
      if (pending !== null && pending.callId === callId) {
        rec.pendingApproval = null;
        pending.resolve(verdict);
        return Promise.resolve();
      }
      // The event is emitted before the bridge is called, so a frontend that answers the
      // moment it sees `approval.requested` can legitimately arrive first. Hold it for
      // the bridge instead of rejecting an answer the user (or `--yes`) already gave.
      if (rec.earlyApprovals.size >= MAX_EARLY_APPROVALS) {
        return Promise.reject(
          new ProtocolHostError(`too many approvals arrived before the kernel asked for call ${callId}`, ERROR_CODES.hostRefused, {
            sessionId,
            callId,
          }),
        );
      }
      rec.earlyApprovals.set(callId, verdict);
      return Promise.resolve();
    },

    readAttachment(id: string, maxBytes: number | null): Promise<AttachmentBytes> {
      const attachment = attachments.get(id);
      if (attachment === undefined) {
        // Only what this host has seen in a session log is served: the id is a path, and
        // "any path the client names" would make the protocol a file reader.
        return Promise.reject(new ProtocolHostError(`no such attachment: ${id}`, ERROR_CODES.hostRefused, { id }));
      }
      const limit = maxBytes === null ? ATTACHMENT_HARD_LIMIT_BYTES : Math.min(maxBytes, ATTACHMENT_HARD_LIMIT_BYTES);
      try {
        const materialized = materializeAttachment(attachment, { hardLimitBytes: limit });
        return Promise.resolve({
          id,
          mediaType: materialized.mediaType,
          byteLength: materialized.byteLength,
          data: materialized.base64,
        });
      } catch (error) {
        if (error instanceof AttachmentUnavailableError) {
          // Two different refusals: "too big" has a number the client can act on, and
          // anything else (gone, unreadable) is a plain refusal with the reason.
          return error.byteLength !== null && error.byteLength > limit
            ? Promise.reject(new AttachmentTooLargeError(id, error.byteLength, limit))
            : Promise.reject(
                new ProtocolHostError(`attachment ${id} cannot be read: ${error.reason}`, ERROR_CODES.hostRefused, { id }),
              );
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async close(): Promise<void> {
      mcpLifetime.abort();
      await mcp.close();
      // Abort the turns first: a turn stopped between `tool.finished` and
      // `tool.background.started` still has a start to record, and its task's exit is
      // waiting for that record. Only then stop the tasks and drain the writes.
      for (const rec of sessions.values()) {
        rec.running?.controller.abort();
        await rec.running?.done;
      }
      await background.stopAll();
      // A loop, not one pass: flushing a buffered exit adds a write, and that write may be
      // followed by another task's exit. `stopAll` guarantees the writers are finite.
      while (backgroundWrites.size > 0) {
        await Promise.allSettled([...backgroundWrites]);
      }
      for (const rec of sessions.values()) {
        rec.unsubscribe();
        await rec.session.close();
      }
      sessions.clear();
      pendingBackgroundExits.clear();
      startedBackground.clear();
    },
  };
}

/**
 * The approval bridge.
 *
 * The kernel asks with the request in hand, and that request already carries the id the
 * frontend will answer with (`ActionRequest.callId`), so nothing has to be paired against
 * a log event. One question at a time, because `runTurn` runs tool calls serially — a
 * second concurrent ask is a bug and is reported as one rather than silently queueing.
 */
function askApproval(rec: SessionRecord, request: ActionRequest): Promise<ApprovalVerdict> {
  return new Promise<ApprovalVerdict>((resolve, reject) => {
    if (rec.pendingApproval !== null) {
      reject(new ProtocolHostError('an approval is already pending in this session', ERROR_CODES.hostRefused));
      return;
    }
    const early = rec.earlyApprovals.get(request.callId);
    if (early !== undefined) {
      rec.earlyApprovals.delete(request.callId);
      resolve(early);
      return;
    }
    rec.pendingApproval = { callId: request.callId, resolve };
  });
}

function createTools(options: {
  readonly cwd: string;
  readonly platform: PlatformPort;
  readonly process: ProcessPort;
  readonly sandbox: ResolvedSandboxProfile['profile'];
  readonly background: BackgroundTasksPort;
  readonly allowBackground: boolean;
  /** Where oversized tool results spill (ADR-119). */
  readonly spill: SpillConfig;
  /** Trusted, visible skills; empty means no `Skill` tool is offered at all (ADR-117 ①). */
  readonly skills: readonly SkillFile[];
}): ReadonlyMap<string, ToolPort> {
  const tools: readonly ToolPort[] = [
    createReadTool({ cwd: options.cwd, spill: options.spill }),
    createWriteTool({ cwd: options.cwd }),
    createEditTool({ cwd: options.cwd }),
    createGlobTool({ cwd: options.cwd }),
    createGrepTool({ cwd: options.cwd }),
    createBashTool({
      cwd: options.cwd,
      platform: options.platform,
      process: options.process,
      sandbox: options.sandbox,
      // Absent rather than a fake that refuses: "this build has no background tasks" is a
      // capability of the host, and the tool's own message already says what to do instead.
      ...(options.allowBackground ? { background: options.background } : {}),
      spill: options.spill,
    }),
    createTodoWriteTool(),
    // No skills, no tool: an empty `Skill` would only tell the model what is not there.
    ...(options.skills.length === 0 ? [] : [createSkillTool({ skills: options.skills })]),
  ];
  return new Map(tools.map((tool) => [tool.spec.name, tool]));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
