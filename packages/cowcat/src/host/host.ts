import {
  AttachmentTooLargeError,
  ERROR_CODES,
  NoSuchSessionError,
  ProtocolHostError,
  type ApprovalVerdict,
  type AttachedSession,
  type AttachmentBytes,
  type CronJobSummary,
  type ProtocolHost,
  type SessionSummary,
} from '@corescense/cowcat-protocol';
import { join } from 'node:path';
import { createBashTool } from '../adapters/tools/bash.js';
import { hashFile, restoreAfter, restoreBefore } from '../adapters/checkpoint.js';
import type { SpillConfig } from '../adapters/spill.js';
import { createEditTool } from '../adapters/tools/edit.js';
import { createGlobTool } from '../adapters/tools/glob.js';
import { createGrepTool } from '../adapters/tools/grep.js';
import { createReadTool } from '../adapters/tools/read.js';
import { createTodoWriteTool } from '../adapters/tools/todo.js';
import { createRememberTool } from '../adapters/tools/remember.js';
import { createViewTool } from '../adapters/tools/view.js';
import { createWriteTool } from '../adapters/tools/write.js';
import { NodeBackgroundTasks } from '../adapters/background.js';
import { AttachmentUnavailableError, materializeAttachment } from '../adapters/attachments.js';
import { createSpanTranslator, initTelemetry, type TelemetryHandle } from '../adapters/otel/index.js';
import { FileLockPort, FileSnapshotPort, JsonlEventStore, randomIds, systemClock } from '../adapters/node.js';
import { NodeFs } from '../adapters/fs.js';
import { readUserProviders, writeUserProvider } from '../adapters/providers.js';
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
import { PROMPT_FILE_MAX_COUNT, PromptFileError, readPromptFile } from '../adapters/prompt-files.js';
import { createSkillTool } from '../adapters/tools/skill.js';
import { createCronTools } from '../adapters/tools/cron.js';
import { GLOBAL_INSTRUCTION_FILENAME, decideInstruction } from '../policy/instructions.js';
import { projectRootOf } from '../adapters/instructions.js';
import { decideSkills } from '../policy/skills.js';
import { CRON_MAX_JOBS, CRON_RECURRING_TTL_MS, isDue, nextFire, parseSchedule, type CronSpec } from '../policy/cron.js';
import { Session, type SessionDeps } from '../kernel/session.js';
import { isTerminal } from '../kernel/turn.js';
import type { PlanChoice } from '../kernel/plan.js';
import { runTurn, ensureInstructions, ensureSkills, describeTurnNote, type TurnDeps, type TurnNote } from '../kernel/run-turn.js';
import { compactContext } from '../kernel/compact.js';
import type { AttachedFile, EventInput, KernelEvent, SessionUpdate } from '../kernel/events.js';
import { trustedRules, isTrusted } from '../policy/trust.js';
import { resolveSandboxProfile, type ResolvedSandboxProfile } from '../policy/sandbox-profile.js';
import type { CowcatConfig, ResolvedModelSettings } from '../policy/config.js';
import type { ActionRequest, Rule } from '../policy/decide.js';
import {
  ATTACHMENT_HARD_LIMIT_BYTES,
  LockHeldError,
  type Attachment,
  type Clock,
  type BackgroundExit,
  type BackgroundTasksPort,
  type CronCreatedRef,
  type CronJobInfo,
  type CronTasksPort,
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
import { BUILTIN_PRESETS } from './presets.js';
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
  /**
   * Overrides telemetry construction (ADR-132/134); a test hook, not a product
   * surface. `null` forces telemetry off, a handle supplies the sink.
   */
  readonly telemetry?: TelemetryHandle | null;
  readonly platform?: PlatformPort;
  readonly process?: ProcessPort;
  readonly store?: EventStore;
  readonly lock?: LockPort;
  readonly snapshots?: SnapshotPort;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  /** `add` is the write half of the trust gate (ADR-157); the default store has both. */
  readonly trustStore?: {
    load(): Promise<{ readonly trusted: readonly string[]; readonly problem: string | null }>;
    add(path: string): Promise<void>;
  };
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
  /**
   * Facts about the workspace the profile must admit but a config file cannot name
   * honestly (ADR-147): the CLI's worktree flow passes the main checkout's git dir so
   * `git commit` works from inside a worktree session. Appended to the config's
   * allow lists BEFORE resolution, so every entry is canonicalized by the same
   * `resolveEntries` path (ADR-017); they are the host's facts, never new verdict types.
   */
  readonly extraWritePaths?: readonly string[];
  readonly extraReadPaths?: readonly string[];
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

/** The plan-review twin of {@link PendingApproval} (ADR-125 ③). */
interface PendingPlan {
  readonly callId: string;
  readonly resolve: (choice: PlanChoice) => void;
}

interface QueuedTurn {
  readonly turnId: string;
  readonly input: string;
  readonly files: readonly AttachedFile[];
  readonly controller: AbortController;
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
  pendingPlan: PendingPlan | null;
  /** The plan-review twin of `earlyApprovals`: a fast answer must not be lost to the seam. */
  readonly earlyPlanReplies: Map<string, PlanChoice>;
  running: { readonly controller: AbortController; readonly done: Promise<void> } | null;
  /** Set while a reflect turn owns the record (ADR-137 ③ re-entry guard). */
  reflecting: boolean;
  /**
   * True from the running-check until the turn is handed to `startTurn`: brackets the
   * `await`s of `@` file reading so a second concurrent `sendTurn` cannot slip through
   * (review of #173, P1-3).
   */
  turnStarting: boolean;
  /**
   * Settled-flag twin of `running`: the terminal transition reaches a client before the
   * cleanup microtask clears `running`, so "the last state is terminal" alone cannot
   * prove idleness — a NEW turn's hooks run before its `turn.opened` (review of #173,
   * P1-4). Only `turnEnded === true` means this record's turn is actually done.
   */
  turnEnded: boolean;
  readonly queue: QueuedTurn[];
  readonly startingControllers: Set<AbortController>;
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
  const rules = withHostRules([
    ...trustedRules(config, { trusted: workspaceTrusted }),
    // ADR-136 ②, the pre-ask half of the trust mirror. Without these, the write-ask
    // rule would prompt for a project-memory write that the tool then refuses —
    // training the user to approve writes that cannot succeed. Deny beats ask
    // regardless of position (decide's precedence). An Escalate appeal can override
    // the deny, which is why the tool ALSO refuses: untrusted stays untrusted.
    // `command` matches the input's target field — Remember borrows commandInput to
    // expose its destination, which also makes approvalKey name+target (ADR-136 ⑤).
    ...(workspaceTrusted
      ? []
      : [
          {
            name: 'remember-instructions-project-needs-trust',
            verdict: 'deny' as const,
            reason:
              'this workspace is not trusted, so CowCat will not write project memory from it (ADR-136); trust the workspace and start a new session',
            when: { tool: 'Remember', command: 'instructions-project' },
          },
          {
            name: 'remember-skill-project-needs-trust',
            verdict: 'deny' as const,
            reason:
              'this workspace is not trusted, so CowCat will not write project memory from it (ADR-136); trust the workspace and start a new session',
            when: { tool: 'Remember', command: 'skill-project' },
          },
        ]),
  ]);

  const platform = options.platform ?? new NodePlatform({ env: options.env });
  const sandbox = resolveSandboxProfile(
    {
      ...config.sandbox,
      write: {
        ...config.sandbox.write,
        allow: [...(options.extraWritePaths ?? []), ...config.sandbox.write.allow],
      },
      read: {
        ...config.sandbox.read,
        allow: [...(options.extraReadPaths ?? []), ...config.sandbox.read.allow],
      },
    },
    { cwd: options.cwd, home: options.home, fs },
  );
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

  // The trust gate's read side (ADR-157 ②): what the project layer is holding back, as
  // counts. Computed by asking the same deciders the loaded session would use, with and
  // without trust — never a second discovery pass, and `0` everywhere means the TUI has
  // nothing to ask about and stays quiet in a bare directory.
  const trustWithheld = workspaceTrusted
    ? { rules: 0, instructions: 0, skills: 0, mcpServers: 0, hooks: 0 }
    : await (async () => {
        const instructionChain = await new FileInstructionSource({ fs }).chain(options.cwd, {
          global: join(paths.dir, GLOBAL_INSTRUCTION_FILENAME),
        });
        // The skipped-untrusted decision carries exactly the project files trust would
        // admit (policy/instructions.ts), so it IS the count — no second discovery pass.
        const untrustedDecision = decideInstruction(instructionChain, { trusted: false });
        const skillsWithheld =
          skillDecision.kind === 'skipped-untrusted'
            ? skillDecision.skills.length
            : skillDecision.kind === 'injected'
              ? skillDecision.skipped.length
              : 0;
        return {
          rules: trustedRules(config, { trusted: true }).length - trustedRules(config, { trusted: false }).length,
          instructions: untrustedDecision.kind === 'skipped-untrusted' ? untrustedDecision.files.length : 0,
          skills: skillsWithheld,
          mcpServers: Object.values(config.mcp.servers).filter((entry) => entry.origin === 'project').length,
          hooks: hookSources.skippedUntrusted,
        };
      })();
  const hooksPort = createHooksPort({
    parsed: hookSources.parsed,
    process: processes,
    platform,
    sandbox: sandbox.profile,
    projectDir: projectRoot ?? options.cwd,
    sessionsDir: paths.sessionsDir,
  });

  // The vision endpoint for the View tool (ADR-138 ③): LAZY. selectModel and
  // createModelPort fail on a missing key or unknown preset, and that failure belongs
  // to the first View call (a refusal the model can relay), never to createHost —
  // the otel malformed-endpoint lesson, same shape. Only successes are cached.
  // An EXPLICIT user config is validated eagerly, though: a typo'd preset id is a
  // config error and should be loud at startup, not at first use. The main model's
  // effort is explicitly NOT inherited: the vision preset's own limits govern.
  const visionPresetId = config.vision ?? 'zai/glm-4v-flash';
  if (config.vision !== undefined) {
    try {
      selectModel({ ...config.model, preset: visionPresetId, effort: null });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  let visionCache: { readonly port: ModelPort; readonly model: string; readonly maxTokens?: number } | null = null;
  const visionEndpoint = (): { readonly port: ModelPort; readonly model: string; readonly maxTokens?: number } => {
    if (visionCache === null) {
      const selection = selectModel({ ...config.model, preset: visionPresetId, effort: null });
      visionCache = {
        port: createModelPort(selection, options.env, options.fetch === undefined ? {} : { fetch: options.fetch }),
        model: selection.preset.model,
        // Anthropic-protocol presets refuse a request without max_tokens
        // (model-anthropic.ts); the vision preset's declared output limit is the
        // honest value (review of #198, P1-2).
        ...(selection.preset.limits.output === undefined ? {} : { maxTokens: selection.preset.limits.output }),
      };
    }
    return visionCache;
  };

  // ---- Cron job tables (ADR-140~142). A table is a fold of one session's cron.* events —
  // built lazily from the store, then kept current by the live-event branch in deliver().
  // The scheduler and the CronTasksPort both read these tables; neither invents state.

  interface CronJobEntry {
    readonly jobId: string;
    readonly schedule: string;
    readonly prompt: string;
    readonly recurring: boolean;
    readonly createdAt: number;
    readonly expiresAt: number | null;
    readonly lastFiredAt: number | null;
    /** A schedule the folder could not parse never fires; it stays listed, nextRun null. */
    readonly spec: CronSpec | null;
  }

  const cronTables = new Map<string, Map<string, CronJobEntry>>();
  /**
   * Live cron.* events that arrived while a session's table was being materialized
   * (readAll in flight). deliver() cannot fold into a table that does not exist yet;
   * buffering here and draining after the read closes the window. Double-folding a
   * drained event is harmless — every fold branch is idempotent by jobId.
   */
  const cronBuffers = new Map<string, KernelEvent[]>();

  function foldCronEvent(table: Map<string, CronJobEntry>, event: KernelEvent): void {
    if (event.type === 'cron.created') {
      const parsed = parseSchedule(event.schedule);
      table.set(event.jobId, {
        jobId: event.jobId,
        schedule: event.schedule,
        prompt: event.prompt,
        recurring: event.recurring,
        createdAt: event.createdAt,
        expiresAt: event.expiresAt,
        lastFiredAt: null,
        spec: parsed.ok ? parsed.spec : null,
      });
      return;
    }
    if (event.type === 'cron.deleted') {
      table.delete(event.jobId);
      return;
    }
    if (event.type === 'cron.fired') {
      const entry = table.get(event.jobId);
      if (entry === undefined) return;
      // A one-shot fired its single shot: the projection drops it without a deleted
      // event (ADR-141 ④ — fired IS its terminal state).
      if (!entry.recurring) {
        table.delete(event.jobId);
        return;
      }
      // Anchor at the SCHEDULED SLOT, not the actual fire instant: a */5 job legitimately
      // fires 15s early (ADR-141 ⑥), and anchoring at 10:04:45 would leave 10:05:00 due
      // for a second fire of the same slot. A slot far in the past means the fire was
      // delayed by a long turn — anchor at the fact then, so missed slots are not caught
      // up in a burst (ADR-141 ① "错过不补").
      const after = entry.lastFiredAt ?? entry.createdAt;
      const slot = entry.spec === null ? null : nextFire(entry.spec, after);
      const anchored = slot !== null && slot > event.firedAt - 60_000 ? slot : event.firedAt;
      table.set(event.jobId, { ...entry, lastFiredAt: anchored });
    }
  }

  async function cronTableFor(sessionId: string): Promise<Map<string, CronJobEntry>> {
    const existing = cronTables.get(sessionId);
    if (existing !== undefined) return existing;
    const table = new Map<string, CronJobEntry>();
    for (const event of await store.readAll(sessionId)) foldCronEvent(table, event);
    // Drain whatever arrived during the read: those events are newer than the log
    // snapshot, and the deliver() branch could not fold them (no table yet).
    const buffered = cronBuffers.get(sessionId);
    if (buffered !== undefined) {
      for (const event of buffered) foldCronEvent(table, event);
      cronBuffers.delete(sessionId);
    }
    cronTables.set(sessionId, table);
    return table;
  }

  /** Ensure the scheduler sees a session's jobs (ADR-140: resume replays them for free —
   *  but only if the projection is actually built; the tick only walks materialized tables). */
  function materializeCronTable(sessionId: string): void {
    if (!cronEnabled) return;
    void cronTableFor(sessionId).catch(() => undefined);
  }

  /**
   * The cron scheduler (ADR-140~142). A 1-second heartbeat walks every session's job
   * table, fires at most one due job per session per tick, and hands the turn the
   * unattended narrowing — a cron fire by definition has no reader, so asks refuse
   * immediately instead of waiting out the approval timeout.
   *
   * Off in unattended hosts for the same reason background tasks are (ADR-112): a
   * `cowcat run` process is one-shot, and jobs firing into it would spend model budget
   * on results nobody reads. The tools are absent there too — the port is undefined.
   */
  const cronEnabled = config.cron?.enabled !== false && options.unattended !== true;
  let hostClosed = false;
  // The scheduler reasons in the injected clock's time: a test that fakes the clock can
  // then decide due-ness without waiting out a real minute (session event timestamps use
  // the same clock via sessionDeps).
  const clock = options.clock ?? systemClock;
  const clockNow = (): number => clock.now();

  const cronPort: CronTasksPort | undefined = cronEnabled
    ? {
        async create(sessionId, request) {
          // The tool parsed already; a port that trusts its caller's parse can be handed
          // a lie, so the schedule is parsed again here — the answer, not the question.
          const parsed = parseSchedule(request.schedule);
          if (!parsed.ok) return { ok: false, error: parsed.error };
          const table = await cronTableFor(sessionId);
          if (table.size >= CRON_MAX_JOBS) {
            return { ok: false, error: `this session already has ${String(CRON_MAX_JOBS)} live jobs; delete some with CronDelete first` };
          }
          const createdAt = clockNow();
          const ref: CronCreatedRef = {
            jobId: sessionDeps.ids.next('job'),
            schedule: request.schedule,
            prompt: request.prompt,
            recurring: request.recurring,
            createdAt,
            expiresAt: request.recurring ? createdAt + CRON_RECURRING_TTL_MS : null,
          };
          // The table learns about this job from its cron.created event (deliver folds
          // it), keeping the port a reader of the log like everything else here.
          return { ok: true, job: ref, nextRun: nextFire(parsed.spec, createdAt) };
        },
        async remove(sessionId, jobId) {
          const table = await cronTableFor(sessionId);
          return table.has(jobId);
        },
        async list(sessionId) {
          const table = await cronTableFor(sessionId);
          const jobs: CronJobInfo[] = [];
          for (const entry of table.values()) {
            jobs.push({
              jobId: entry.jobId,
              schedule: entry.schedule,
              prompt: entry.prompt,
              recurring: entry.recurring,
              createdAt: entry.createdAt,
              expiresAt: entry.expiresAt,
              nextRun: entry.spec === null ? null : nextFire(entry.spec, entry.lastFiredAt ?? entry.createdAt),
              lastFiredAt: entry.lastFiredAt,
            });
          }
          return jobs;
        },
      }
    : undefined;

  function cronDueJobs(table: Map<string, CronJobEntry>, now: number): CronJobEntry[] {
    const due: { entry: CronJobEntry; next: number }[] = [];
    for (const entry of table.values()) {
      if (entry.spec === null) continue;
      const after = entry.lastFiredAt ?? entry.createdAt;
      if (isDue(entry.spec, after, now)) due.push({ entry, next: nextFire(entry.spec, after) ?? Number.POSITIVE_INFINITY });
    }
    return due.sort((a, b) => a.next - b.next).map((item) => item.entry);
  }

  async function fireCronJob(rec: SessionRecord, job: CronJobEntry, now: number): Promise<void> {
    // Re-check idleness in THIS scope: cronTick's guard ran before the expired-loop's
    // awaits, and a user send (or a reflect turn) may have claimed the record since.
    // Firing into a busy record would open a second turn on one session — startTurn
    // throws, the fire is consumed, and an orphan `cron.fired` is left (review P1-1).
    if (rec.running !== null || rec.turnStarting || rec.reflecting) return;
    // Claim BEFORE any await, the same bracket sendTurn uses: a user send landing in
    // the gap would otherwise open a second turn on one session and interleave the log.
    rec.turnStarting = true;
    try {
      const configured = currentModel(rec.session.state.sessionId);
      // The fired event names the turn before it exists (ADR-140 ②); the turn opens
      // under that reserved name so the audit link cannot break.
      const turnId = sessionDeps.ids.next('turn');
      await rec.session.emit({ type: 'cron.fired', turnId, jobId: job.jobId, firedAt: now });
      await startTurn(rec, configured, job.prompt, new AbortController(), 'cron', turnId);
      // A recurring job that has reached its expiry fires once more (this fire), then
      // deletes itself — a bounded end, not a silent disappearance (ADR-141 ⑤).
      if (job.recurring && job.expiresAt !== null && now >= job.expiresAt) {
        await rec.session.cronDeleted(job.jobId, 'expiry', clockNow());
      }
    } catch {
      // The fired event is written before the turn opens, so a failure here (an
      // unconfigured model, a turn that refuses to open) CONSUMES the fire: the fold
      // anchors lastFiredAt and the job is not retried. That matches ADR-141 ①/②
      // ("错过不补"; the event records the enqueue). A one-shot's only shot is spent.
    } finally {
      rec.turnStarting = false;
    }
  }

  async function cronTick(): Promise<void> {
    if (hostClosed) return;
    const now = clockNow();
    for (const [sessionId, table] of cronTables) {
      const rec = sessions.get(sessionId);
      // The same triple maybeReflect guards on: a running turn, a turn being claimed,
      // or a reflect turn all mean "not idle". Cron fires between turns only (ADR-141 ①).
      if (rec === undefined || rec.running !== null || rec.turnStarting || rec.reflecting) continue;
      const expired = [...table.values()].filter(
        (entry) => entry.recurring && entry.expiresAt !== null && now > entry.expiresAt && entry.spec !== null && !isDue(entry.spec, entry.lastFiredAt ?? entry.createdAt, now),
      );
      for (const job of expired) {
        // Expired with no due moment left: delete without a fire. The opposite order
        // (fire, then delete) is fireCronJob's expiry branch. The await opens a window
        // in which a user send can claim the record — the idle re-check below covers it.
        await rec.session.cronDeleted(job.jobId, 'expiry', now).catch(() => undefined);
      }
      const due = cronDueJobs(table, now);
      if (due.length === 0) continue;
      // At most one cron turn per HEARTBEAT, globally (ADR-141 ①): several sessions'
      // */5 jobs align on the same minute boundary, and firing them all in one tick is
      // the local version of the thundering herd the upstream jitter exists to break.
      // A backlog drains one fire per second; the idle re-check lives inside
      // fireCronJob (fresh scope — the expired-loop's awaits may have let a turn start).
      void fireCronJob(rec, due[0] as CronJobEntry, now);
      break;
    }
  }

  const cronTimer = cronEnabled ? setInterval(() => void cronTick(), 1000) : null;
  if (cronTimer !== null && typeof cronTimer.unref === 'function') cronTimer.unref();

  const builtinTools = createTools({
    cwd: options.cwd,
    platform,
    process: processes,
    sandbox: sandbox.profile,
    background,
    allowBackground: options.unattended !== true,
    cron: cronPort,
    now: clockNow,
    skills: availableSkills,
    spill: { rootDir: paths.sessionsDir },
    home: options.home,
    workspaceTrusted,
    vision: visionEndpoint,
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
  // The reflect turn's only door (ADR-137 ②): no delegation, no skills, nothing but
  // Remember. Built a filter, not a lookup assertion, so a future build without the
  // tool still type-checks and simply offers no doors.
  const reflectTools: ReadonlyMap<string, ToolPort> = new Map([...tools].filter(([name]) => name === 'Remember'));
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
  const modelOverrides = new Map<string, ResolvedModelSettings>();
  const modelCache = new Map<string, { readonly port: ModelPort; readonly selection: ModelSelection }>();

  // The model is built from the config, so a config problem becomes a refusal the
  // frontend can read instead of a stack trace it cannot (see the header, note 2).
  function currentModel(sessionId?: string): { readonly port: ModelPort; readonly selection: ModelSelection } {
    try {
      const override = sessionId === undefined ? undefined : modelOverrides.get(sessionId);
      if (sessionId !== undefined && override !== undefined) {
        const cached = modelCache.get(sessionId);
        if (cached !== undefined) return cached;
        const selected = selectModel(override);
        const built = createModelPort(selected, options.env, options.fetch === undefined ? {} : { fetch: options.fetch });
        const configured = { port: options.model ?? built, selection: selected };
        modelCache.set(sessionId, configured);
        return configured;
      }
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
    const configured = currentModel(request.parentSessionId);
    const child = await Session.create(sessionDeps, request.sessionId, {
      parent: { sessionId: request.parentSessionId, role: request.role },
    });
    // The child's tokens are real provider spend (its usage is summed into the
    // parent's outcome) — it gets its own span tree under its own conversation id,
    // same as any session (ADR-132 ③).
    const unsubscribeTelemetry = spanTap === null ? null : child.subscribe(spanTap.observe);
    await primeTelemetry(request.sessionId);
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
      if (unsubscribeTelemetry !== null) {
        unsubscribeTelemetry();
        spanTap?.forget(request.sessionId);
      }
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
    } else if (update.type === 'turn.transitioned' && isTerminal(update.to)) {
      // The record is cleaned at EVENT time, synchronously inside emit — before any
      // transport delivery — so by the moment a client can observe the terminal state,
      // `rec.running` is already null. A flag cleared in a later microtask reintroduced
      // exactly the race the fork grace tried to paper over (review of #173, P1-4).
      rec.running = null;
      rec.turnEnded = true;
      rec.pendingApproval = null;
      rec.pendingPlan = null;
      // An answer for a call that never reached the bridge must not outlive the turn.
      rec.earlyApprovals.clear();
      rec.earlyPlanReplies.clear();
      rec.turnWaiters = [];
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
    } else if (update.type === 'cron.created' || update.type === 'cron.deleted' || update.type === 'cron.fired') {
      // Keep a materialized table in step with the log it was folded from (ADR-140).
      // No table yet (first materialization still reading) → buffer; cronTableFor
      // drains after its read. Double-folding a drained event is harmless: every fold
      // branch is idempotent by jobId.
      const table = cronTables.get(update.sessionId);
      if (table !== undefined) {
        foldCronEvent(table, update);
      } else {
        const buffered = cronBuffers.get(update.sessionId);
        if (buffered === undefined) cronBuffers.set(update.sessionId, [update]);
        else buffered.push(update);
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
      pendingPlan: null,
      earlyPlanReplies: new Map(),
      running: null,
      turnStarting: false,
      turnEnded: true,
      reflecting: false,
      queue: [],
      startingControllers: new Set(),
    };
    // Telemetry subscribes FIRST: Session notifies listeners in order and a throwing
    // delivery listener must not take the span view down with it (ADR-132 ④).
    const unsubscribeTelemetry = spanTap === null ? null : session.subscribe(spanTap.observe);
    const unsubscribeDelivery = session.subscribe((update) => {
      deliver(rec, update);
    });
    rec.unsubscribe = () => {
      unsubscribeDelivery();
      if (unsubscribeTelemetry !== null) unsubscribeTelemetry();
      // The translator keys conversations by sessionId and is host-scoped; a closed
      // session's bookkeeping must not outlive it (long-lived serve processes adopt
      // many short sessions).
      if (spanTap !== null) spanTap.forget(session.state.sessionId);
    };
    return rec;
  }

  /**
   * Feed the session header to the telemetry tap. `session.opened` is emitted at
   * Session.create/open, BEFORE this host could subscribe, so the tap never sees it
   * on the wire — and the header is the only place the creating preset id (hence
   * `gen_ai.provider.name`, a semconv Required attribute) appears. One bounded read
   * (EventStore.readHeader), not a replay: replayed history must not enter
   * telemetry (ADR-132 ②).
   */
  async function primeTelemetry(sessionId: string): Promise<void> {
    if (spanTap === null) return;
    try {
      const header = await store.readHeader(sessionId);
      if (header !== null && header.type === 'session.opened') spanTap.observe(header);
    } catch {
      // Telemetry primes itself best-effort, like everything else it does.
    }
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
      await primeTelemetry(sessionId);
      // resume/打开即物化作业表：调度器只遍历已物化的表，不物化就等于「resume 后
      // 周期作业静默停摆」——ADR-140 的免费恢复在调度链路上也要兑现（review P0-2）。
      materializeCronTable(sessionId);
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

  /**
   * The turn body, split from `sendTurn` so the check-and-claim flag can bracket the
   * file-reading awaits above. Everything from here to `rec.running` is synchronous,
   * which is what keeps the hand-off race-free.
   *
   * `kind`: 'user' turns get the full surface; 'reflect' turns get the narrowed
   * reflect tool set (ADR-137 ②); 'cron' turns get the full surface minus plan review
   * and Escalate, plus the unattended narrowing (ADR-142 — nobody can answer a
   * question in a fired turn, so the tools that ask are kept off the wire instead of
   * being offered to fail). `reservedTurnId` is only the cron scheduler's (the fired
   * event named it first, ADR-140 ②).
   */
  async function startTurn(
    rec: SessionRecord,
    configured: { readonly port: ModelPort; readonly selection: ModelSelection },
    input: string,
    controller: AbortController,
    kind: 'user' | 'reflect' | 'cron' = 'user',
    reservedTurnId?: string,
  ): Promise<{ turnId: string }> {
    const deps: TurnDeps = {
      session: rec.session,
      model: configured.port,
      preset: configured.selection.preset,
      ...(configured.selection.effort === null ? {} : { effort: configured.selection.effort }),
      // A reflect turn gets exactly one door: Remember (ADR-137 ②). No delegation, no
      // plan review, no escalation appeals, no skill catalog, no hooks — an
      // unobserved loop (hook → prompt → turn) is exactly what a background turn
      // must not create.
      tools: kind === 'reflect' ? reflectTools : tools,
      rules,
      fs,
      approve: (request: ActionRequest) => askApproval(rec, request),
      ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
      // A fired cron turn refuses asks before any bridge is reached — the reason names
      // the situation so the model reports what it needed instead (ADR-142).
      ...(kind === 'cron' ? { unattended: 'cron turns cannot ask a human; report what you needed instead' } : {}),
      ids: sessionDeps.ids,
      // The cron scheduler reserved the turn's name in its fired event (ADR-140 ②);
      // opening under any other id would break the audit link.
      ...(reservedTurnId === undefined ? {} : { reservedTurnId }),
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
      ...(kind === 'reflect'
        ? {}
        : {
            skills: {
              skills: skillDiscovery.skills,
              trust: { trusted: workspaceTrusted },
              ...(configured.selection.preset.limits.context === undefined
                ? {}
                : { window: configured.selection.preset.limits.context }),
            },
          }),
      // Delegation is available to a top-level session only: the child's deps are built
      // without this field, which is what makes depth 0 the default (ADR-081 ④).
      ...(kind === 'reflect' ? {} : { subagents: { port: { spawn: spawnSubagent } } }),
      // Hooks ride top-level turns for the same reason delegation does (ADR-121).
      ...(kind === 'reflect' ? {} : { hooks: { port: hooksPort, cwd: options.cwd } }),
      // Plan review is top-level and attended only: cron turns are unattended by
      // definition (ADR-142) and children never review (ADR-124 ⑥). Omitting the field
      // keeps ExitPlan off the wire instead of offering a call that can only fail.
      ...(kind === 'user' ? { planReview: (callId: string) => askPlanReview(rec, callId) } : {}),
      // Escalate appeals are top-level, attended turns only: an appeal needs a reader,
      // and a cron turn has none (ADR-129/142 — the Task/ExitPlan gating precedent).
      ...(kind === 'user' ? { escalation: true } : {}),
    };

    let failure: unknown = null;
    const done = runTurn(deps, input, controller.signal).then(
      () => undefined,
      (error: unknown) => {
        failure = error;
      },
    );
    const settled = done.then(() => undefined);
    rec.turnEnded = false;
    rec.running = { controller, done: settled };
    // RACE, not all: the reply has to go out while the turn is still running, and the
    // answer is the id the session reported when it opened the turn. If the turn ends
    // first the id is still there — a session keeps its last turn — so a turn that
    // opens and completes in one go answers correctly too.
    const opened = new Promise<string>((resolve) => {
      rec.turnWaiters.push(resolve);
    });
    await Promise.race([settled, opened]);
    const turnId = rec.session.turnId;
    if (turnId === null) {
      throw new ProtocolHostError(
        `the turn ended before it opened: ${message(failure ?? new Error('no turn was opened'))}`,
        ERROR_CODES.hostRefused,
        { sessionId: rec.session.state.sessionId },
      );
    }
    if (kind === 'user') {
      // ADR-137: a completed USER turn optionally triggers background distillation.
      // Fire-and-forget — the reply already went out — and never for the reflect
      // turn itself (that is the re-entry guard; the flag alone would race the
      // finally block that clears it).
      void settled.then(() => {
        void startQueued(rec);
        void maybeReflect(rec);
      });
    }
    return { turnId };
  }

  async function startQueued(rec: SessionRecord): Promise<void> {
    // The while condition is the whole guard: evaluating it is the first thing this
    // function does, and every clause is re-checked after each drained turn (the body
    // awaits, so `running`/`turnStarting`/`reflecting` may all have changed by then).
    while (!hostClosed && rec.queue.length > 0 && rec.running === null && !rec.turnStarting && !rec.reflecting) {
      const queued = rec.queue[0];
      if (queued === undefined) return;
      rec.turnStarting = true;
      try {
        if (queued.files.length > 0) await rec.session.emit({ type: 'prompt.attached', turnId: null, files: queued.files });
        await startTurn(rec, currentModel(rec.session.state.sessionId), queued.input, queued.controller, 'user', queued.turnId);
        rec.queue.shift();
      } catch (error) {
        rec.queue.shift();
        await rec.session.emit({
          type: 'turn.noted',
          turnId: rec.session.turnId,
          note: 'queue-failed',
          message: `Queued turn failed: ${message(error)}`,
        });
      } finally {
        rec.turnStarting = false;
      }
    }
  }

  const reflectEnabled = config.memory?.reflect === 'on';

  const REFLECT_PROMPT = [
    'Reflect on this session, in the background, after the task above completed.',
    '',
    'If the conversation produced genuinely reusable experience — conventions discovered, pitfalls hit, workflows that worked — use the Remember tool to distill it into memory (an AGENTS.md paragraph, or a skill when it is a repeatable procedure). Prefer one strong memory over several weak ones.',
    'If nothing is worth persisting, answer with one sentence saying so and call no tools.',
    'Do not restate task state or one-off facts: memory is for future sessions, not this one.',
  ].join('\n');

  /**
   * ADR-137: the background half of memory distillation. Runs only when the user
   * explicitly turned it on (cost is the user's decision), the session is attended
   * (an approval nobody can answer must not hang a background turn), and the user
   * turn just completed cleanly. Everything it does is swallowed: distillation is
   * opportunistic, never a session event the user did not ask for.
   */
  async function maybeReflect(rec: SessionRecord): Promise<void> {
    if (hostClosed || !reflectEnabled || rec.reflecting || rec.turnStarting) return;
    if (options.unattended === true) return;
    if (rec.running !== null) return;
    const turn = rec.session.state.turn;
    if (turn === null || turn.state !== 'completed') return;
    if (rec.session.state.planMode) return;
    rec.reflecting = true;
    // Claim the same check-and-claim flag sendTurn brackets: without this, a
    // sendTurn that passed its busy check and is awaiting an @-file read (turnStarting
    // true, running still null) lets the reflect turn start underneath it — two
    // concurrent runTurns on one Session, and an interleaved event log that stops
    // replaying (review of #192, P0-1).
    rec.turnStarting = true;
    try {
      await startTurn(rec, currentModel(rec.session.state.sessionId), REFLECT_PROMPT, new AbortController(), 'reflect');
      // The flag means "a reflect turn owns this session", not "one is starting":
      // startTurn answers as soon as the turn OPENS, so hold it until the reflect
      // turn actually settles — the busy message and the re-entry guard both key
      // off the whole turn, and no other turn can start meanwhile (busy check).
      // The getter call is load-bearing: TS narrowed `rec.running` to null at the
      // guard above and keeps that narrowing across the awaits.
      const running = ((): SessionRecord['running'] => rec.running)();
      await running?.done;
    } catch {
      // See the doc comment: never surface.
    } finally {
      rec.turnStarting = false;
      rec.reflecting = false;
      void startQueued(rec);
    }
  }


  // Telemetry is initialized LAST (ADR-134): everything above can throw, and a
  // provider created before a failing step would leak its BatchSpanProcessor.
  // It is a pure view over the live event stream (ADR-132): the tap subscribes in
  // adopt(), and absent an endpoint (config or the standard env var) initTelemetry
  // returns null and the host behaves exactly as it always has — zero overhead is
  // the default. `options.telemetry` overrides the decision entirely; it exists so
  // tests can hand in an in-memory sink without an exporter.
  const telemetry =
    options.telemetry !== undefined
      ? options.telemetry
      : initTelemetry({
          env: options.env,
          endpoint: config.otel?.endpoint,
          headersEnv: config.otel?.headersEnv,
          serviceVersion: version,
        });
  const spanTap = telemetry === null ? null : createSpanTranslator(telemetry.sink, { agentVersion: version });

  return {
    serverVersion: version,
    paths,
    config,
    rules,
    sandbox,
    configWarnings: warnings,

    /**
     * The user layer's providers with key detection (ADR-165 ①). Read from the FILE, not
     * from the resolved config: the panel edits the document, and a resolved view would
     * hide which layer a field came from.
     */
    async listProviders() {
      const providers = await readUserProviders(paths.userConfig);
      return {
        providers: Object.entries(providers).map(([name, entry]) => ({
          name,
          baseUrl: entry.baseUrl ?? null,
          apiKeyEnv: entry.apiKeyEnv ?? null,
          // Detection uses the HOST's environment — the same process that would send
          // the request — not whatever the client shell happens to have.
          keySet: entry.apiKeyEnv !== undefined && (options.env[entry.apiKeyEnv] ?? '') !== '',
        })),
      };
    },

    async setProvider(name: string, fields: { readonly baseUrl?: string; readonly apiKeyEnv?: string }) {
      // The adapter owns the file and the atomic write; a corrupt document refuses
      // rather than being replaced (ADR-165 ①).
      await writeUserProvider(paths.userConfig, name, fields);
    },

    /** The startup snapshot, not a live fact (ADR-157 ②): the host never hot-reloads. */
    trustStatus(): Promise<{ trusted: boolean; withheld: { rules: number; instructions: number; skills: number; mcpServers: number; hooks: number } }> {
      return Promise.resolve({ trusted: workspaceTrusted, withheld: trustWithheld });
    },

    /** Persist the cwd; the RUNNING host is unchanged — the caller rebuilds to apply (ADR-157). */
    async trustGrant() {
      await trustStore.add(options.cwd);
    },

    async listSessions(): Promise<readonly SessionSummary[]> {
      const entries = await index.list();
      // The parent link travels with the summary so a client can fold children out of its
      // own view (ADR-079 ④): the host lists what is on disk, the frontend decides what to
      // show.
      return entries.map((entry) => ({
        sessionId: entry.sessionId,
        lastSeq: entry.lastSeq,
        ...(entry.parentSessionId === null ? {} : { parentSessionId: entry.parentSessionId }),
        ...(entry.parentRole === null ? {} : { parentRole: entry.parentRole }),
        ...(entry.title === null ? {} : { title: entry.title }),
        ...(entry.cwd === null ? {} : { cwd: entry.cwd }),
        ...(entry.model === null ? {} : { model: entry.model }),
      }));
    },

    async createSession(sessionId: string | null): Promise<SessionSummary> {
      const id = sessionId ?? sessionDeps.ids.next('sess');
      if (sessions.has(id)) {
        throw new ProtocolHostError(`session already exists: ${id}`, ERROR_CODES.hostRefused, { sessionId: id });
      }
      let session: Session;
      try {
        // The header records where and as-whom the session started (ADR-126); the
        // configured preset is the initial model, per-turn truth stays on turn.opened.
        session = await Session.create(sessionDeps, id, {
          cwd: options.cwd,
          ...(config.model.preset === null ? {} : { model: config.model.preset }),
        });
      } catch (error) {
        if (error instanceof LockHeldError) throw lockedError(id, error);
        throw new ProtocolHostError(`${id}: ${message(error)}`, ERROR_CODES.hostRefused, { sessionId: id });
      }
      const rec = adopt(session);
      sessions.set(id, rec);
      await primeTelemetry(id);
      // SessionStart (ADR-122 ①): fires once per session creation — resume reopens a
      // log and fires nothing, matching the log's own shape (session.opened exists,
      // re-open does not). Failure cannot reject creation: a broken start hook must
      // not keep a session from existing, so failures land in the session's own log
      // (a turn.noted with no turn yet), where every frontend will see them.
      hooksPort
        .run({ event: 'session-start', sessionId: id, cwd: options.cwd }, new AbortController().signal)
        .then(async (report) => {
          for (const failure of report.failures) {
            try {
              await session.emit({
                type: 'turn.noted',
                turnId: null,
                note: 'hook-failed',
                message: `hook 失败：${failure}`,
              });
            } catch {
              // The session is there to be written; if even that fails, nothing else is honest to do.
            }
          }
        })
        .catch(() => undefined);
      return { sessionId: id, lastSeq: rec.lastSeq };
    },

    /**
     * Fork by replay (ADR-127): a new session is created with the source as its
     * `fork` parent, then every source event is re-emitted — seq, ts and sessionId
     * are re-minted by `emit`, so the fork's log is a first-class log whose audit
     * fields match its identity. A byte copy would leave every line's embedded
     * sessionId pointing at the source and would need a rewritten header, which the
     * append-only store forbids itself to do.
     */
    async forkSession(sessionId: string): Promise<{ readonly sessionId: string }> {
      const rec = await record(sessionId);
      if (rec.running !== null) {
        // The terminal transition reaches a client a beat before the cleanup microtask
        // clears `running`, and a NEW turn's hooks run before its `turn.opened` — so
        // "the last state is terminal" cannot prove idleness. Only this record's own
        // settled flag does (review of #173, P1-4).
        if (rec.turnEnded) {
          rec.running = null;
        } else {
          throw new ProtocolHostError(
            `session ${sessionId} has a running turn; cancel it before forking`,
            ERROR_CODES.hostRefused,
            { sessionId },
          );
        }
      }
      const newId = sessionDeps.ids.next('sess');
      const source = await sessionDeps.store.readAll(sessionId);
      const sourceHeader = source[0];
      // The fork's header inherits the SOURCE's where/who (ADR-126 semantics): a fork
      // taken in another directory is still the same conversation (review of #173, P2-7).
      const inheritedCwd = sourceHeader?.type === 'session.opened' ? sourceHeader.cwd : undefined;
      const inheritedModel = sourceHeader?.type === 'session.opened' ? sourceHeader.model : undefined;
      let forked: Session;
      try {
        forked = await Session.create(sessionDeps, newId, {
          ...(inheritedCwd === undefined ? {} : { cwd: inheritedCwd }),
          ...(inheritedModel === undefined ? {} : { model: inheritedModel }),
          parent: { sessionId, role: 'fork' },
        });
      } catch (error) {
        if (error instanceof LockHeldError) throw lockedError(newId, error);
        throw new ProtocolHostError(`${newId}: ${message(error)}`, ERROR_CODES.hostRefused, { sessionId: newId });
      }
      // Registered before the replay so host.close() cleans the lock and the session
      // even if the replay dies halfway (review of #173, P1-5).
      const forkRec = adopt(forked);
      sessions.set(newId, forkRec);
      try {
        for (const event of source) {
          if (event.type === 'session.opened') continue;
          await forked.emit(stripEventIds(event));
        }
      } catch (error) {
        await forked.close();
        sessions.delete(newId);
        // A half-replayed log would list as a healthy session; the half-born fork is
        // deleted, never resumed (ADR-127).
        await sessionDeps.store.remove?.(newId);
        throw new ProtocolHostError(`fork failed: ${message(error)}`, ERROR_CODES.hostRefused, { sessionId });
      }
      return { sessionId: newId };
    },
    async attach(sessionId: string): Promise<AttachedSession> {
      const rec = await record(sessionId);
      // Subscribe BEFORE reading the log, and hold what arrives until the server has sent
      // the replay: a host that reads first leaves a gap no client can detect, and one
      // that forwards immediately would put a later event before the replay it is part
      // of. The buffer closes the gap; `subscribe` flushes it synchronously before going
      // live, so a fast event can never overtake the queue (review of #173).
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
        // The meter (ADR-131 ①): derived from the same replay the client is about to
        // receive, so the two can never disagree about what has been billed.
        usage: { ...rec.session.state.usageTotals },
        subscribe: (listener: (update: unknown) => void) => {
          const queued = buffered.filter((update) => {
            if (update.type === 'model.delta' || update.type === 'reasoning.delta' || update.type === 'tool.output.delta') {
              return true;
            }
            return update.seq > lastSeq;
          });
          buffered.length = 0;
          // Flush SYNCHRONOUSLY, before `live` is set: an event arriving after
          // `live = listener` but before a deferred flush would overtake the whole
          // buffered queue (observed as [1,3,2] in the seam test once turn-start
          // timing shifted — review of #173). The server calls `subscribe` after its
          // reply and replay are already written, so eager flushing keeps that order
          // instead of racing it.
          for (const update of queued) listener(update);
          live = listener;
          return () => {
            live = null;
            rec.listeners.delete(onUpdate);
          };
        },
      };
    },

    async sendTurn(sessionId: string, input: string, files?: readonly string[]): Promise<{ turnId: string; queued?: boolean }> {
      const rec = await record(sessionId);
      if (rec.running !== null || rec.turnStarting) {
        if (rec.queue.length >= 8) {
          throw new ProtocolHostError(`session ${sessionId} has too many queued turns`, ERROR_CODES.hostRefused, { sessionId });
        }
        currentModel(sessionId);
        const attached = await promptAttachments(files, sessionId);
        const turnId = sessionDeps.ids.next('turn');
        rec.queue.push({ turnId, input, files: attached, controller: new AbortController() });
        return { turnId, queued: true };
      }
      const controller = new AbortController();
      rec.startingControllers.add(controller);
      rec.turnStarting = true;
      try {
        // Before anything is opened: an unconfigured model is a refusal with a hint, not a
        // turn that starts and fails a moment later. This check runs BEFORE any file is
        // read or emitted, so a refusal leaves no orphan `prompt.attached` in the log
        // (review of #173, P1-2).
        const configured = currentModel(sessionId);
        const attached = await promptAttachments(files, sessionId);
        if (attached.length > 0) {
          try {
            await rec.session.emit({ type: 'prompt.attached', turnId: null, files: attached });
          } catch (error) {
            throw new ProtocolHostError(
              `cannot attach files: ${error instanceof Error ? error.message : String(error)}`,
              ERROR_CODES.hostRefused,
              { sessionId },
            );
          }
        }
        return await startTurn(rec, configured, input, controller);
      } finally {
        rec.startingControllers.delete(controller);
        rec.turnStarting = false;
      }
    },

    listModels(sessionId: string) {
      const rec = open(sessionId);
      const current = currentModel(rec.session.state.sessionId).selection;
      const ids = [...new Set([...Object.keys(BUILTIN_PRESETS), ...Object.keys(config.model.presets)])].sort();
      return Promise.resolve({
        current: { id: current.id, effort: current.effort },
        models: ids.map((id) => ({
          id,
          efforts: Object.keys(config.model.presets[id]?.efforts ?? BUILTIN_PRESETS[id]?.efforts ?? {}),
        })),
      });
    },

    setModel(sessionId: string, preset: string, effort?: string | null) {
      const rec = open(sessionId);
      if (rec.running !== null || rec.turnStarting || rec.reflecting) {
        throw new ProtocolHostError(`session ${sessionId} has a turn running`, ERROR_CODES.hostRefused, { sessionId });
      }
      const override = { ...config.model, preset, effort: effort ?? null };
      try {
        const selected = selectModel(override);
        const built = createModelPort(selected, options.env, options.fetch === undefined ? {} : { fetch: options.fetch });
        modelOverrides.set(sessionId, override);
        modelCache.set(sessionId, { port: options.model ?? built, selection: selected });
        return Promise.resolve({ current: { id: selected.id, effort: selected.effort } });
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
    },

    async compactSession(sessionId: string) {
      const rec = open(sessionId);
      if (rec.running !== null || rec.turnStarting || rec.reflecting) {
        throw new ProtocolHostError(`session ${sessionId} has a turn running`, ERROR_CODES.hostRefused, { sessionId });
      }
      rec.turnStarting = true;
      try {
        const configured = currentModel(sessionId);
        const outcome = await compactContext(
          {
            session: rec.session,
            model: configured.port,
            preset: configured.selection.preset,
            tools: configured.selection.preset.toolCalls ? [...tools.values()].map((tool) => tool.spec) : [],
            hooks: { port: hooksPort, cwd: options.cwd },
          },
          'manual',
          new AbortController().signal,
        );
        if (outcome.ok) {
          const note = async (item: TurnNote): Promise<void> => {
            await rec.session.emit({
              type: 'turn.noted',
              turnId: rec.session.turnId,
              note: item.kind,
              message: describeTurnNote(item),
            });
          };
          await ensureInstructions(
            {
              session: rec.session,
              instructions: {
                port: new FileInstructionSource({ fs }),
                cwd: options.cwd,
                trust: { trusted: workspaceTrusted },
                global: join(paths.dir, GLOBAL_INSTRUCTION_FILENAME),
              },
            },
            note,
          );
          await ensureSkills(
            {
              session: rec.session,
              skills: {
                skills: skillDiscovery.skills,
                trust: { trusted: workspaceTrusted },
                ...(configured.selection.preset.limits.context === undefined ? {} : { window: configured.selection.preset.limits.context }),
              },
            },
            note,
          );
        }
        return { compacted: outcome.ok, dropped: outcome.dropped, reason: outcome.reason };
      } finally {
        rec.turnStarting = false;
        void startQueued(rec);
      }
    },

    async listGrants(sessionId: string) {
      const rec = open(sessionId);
      return { grants: standingGrants(await store.readAll(rec.session.state.sessionId)) };
    },

    async revokeGrant(sessionId: string, grantId: string) {
      const rec = open(sessionId);
      const grant = standingGrants(await store.readAll(sessionId)).find((item) => item.id === grantId);
      if (grant === undefined) return { revoked: false };
      await rec.session.emit({ type: 'approval.revoked', turnId: rec.session.turnId, key: grant.key, by: 'user' });
      return { revoked: true };
    },

    async undoChange(sessionId: string) {
      const rec = open(sessionId);
      if (rec.running !== null || rec.turnStarting || rec.reflecting) throw new ProtocolHostError(`session ${sessionId} has a turn running`, ERROR_CODES.hostRefused, { sessionId });
      const operation = latestChange(await store.readAll(sessionId), false);
      if (operation === null) throw new ProtocolHostError('nothing to undo', ERROR_CODES.hostRefused, { sessionId });
      if (operation.afterHash === undefined || hashFile(operation.path) !== operation.afterHash) {
        throw new ProtocolHostError(`cannot undo ${operation.path}: the file changed after CowCat wrote it`, ERROR_CODES.hostRefused, { sessionId });
      }
      const redoPath = restoreBefore({ rootDir: paths.sessionsDir }, sessionId, operation.callId, operation.path, operation.beforePath, operation.created);
      await rec.session.emit({ type: 'file.reverted', turnId: rec.session.turnId, callId: operation.callId, path: operation.path, redoPath });
      return { path: operation.path };
    },

    async redoChange(sessionId: string) {
      const rec = open(sessionId);
      if (rec.running !== null || rec.turnStarting || rec.reflecting) throw new ProtocolHostError(`session ${sessionId} has a turn running`, ERROR_CODES.hostRefused, { sessionId });
      const operation = latestChange(await store.readAll(sessionId), true);
      if (operation === null || operation.redoPath === null) throw new ProtocolHostError('nothing to redo', ERROR_CODES.hostRefused, { sessionId });
      const currentHash = hashFile(operation.path);
      if (operation.beforeHash === undefined || currentHash !== operation.beforeHash) {
        throw new ProtocolHostError(`cannot redo ${operation.path}: the file changed after undo (expected ${String(operation.beforeHash)}, got ${String(currentHash)})`, ERROR_CODES.hostRefused, { sessionId });
      }
      restoreAfter(operation.path, operation.redoPath);
      await rec.session.emit({ type: 'file.restored', turnId: rec.session.turnId, callId: operation.callId, path: operation.path });
      return { path: operation.path };
    },

    async cancelTurn(sessionId: string): Promise<void> {
      const rec = open(sessionId);
      for (const queued of rec.queue) queued.controller.abort();
      rec.queue.length = 0;
      for (const controller of rec.startingControllers) controller.abort();
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

    async listCronJobs(sessionId: string): Promise<readonly CronJobSummary[]> {
      open(sessionId);
      // Cron off in this build (disabled config, unattended host): an empty list is the
      // honest answer — there IS nothing scheduled here, because there is no scheduler.
      if (cronPort === undefined) return [];
      return cronPort.list(sessionId);
    },

    async removeCronJob(sessionId: string, jobId: string): Promise<boolean> {
      const rec = open(sessionId);
      if (cronPort === undefined) return false;
      // Ownership is the projection's word, not the caller's (the task.stop precedent):
      // a false answer means "not this session's live job", never a silent success.
      const owned = await cronPort.remove(sessionId, jobId);
      if (!owned) return false;
      // The deletion is a log fact with by: 'user' — the panel's answer is not the
      // record; the event is (ADR-140).
      await rec.session.cronDeleted(jobId, 'user', clockNow());
      return true;
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

    async setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
      const rec = open(sessionId);
      // A pending review makes "you are still in plan mode" promises the UI and the
      // model are both reading; toggling underneath them would leave each holding a
      // different truth (review of #167, P2-6). Answer the review first.
      if (rec.pendingPlan !== null) {
        throw new ProtocolHostError(
          'a plan review is pending; answer it before toggling plan mode',
          ERROR_CODES.hostRefused,
          { sessionId },
        );
      }
      await rec.session.emit({ type: 'plan.mode-changed', turnId: rec.session.turnId, enabled, by: 'user' });
    },

    async setAcceptEdits(sessionId: string, enabled: boolean): Promise<void> {
      // ADR-159: a user act, exactly like plan mode's toggle. A pending review is not a
      // conflict here — the review is about plans, not write permission — but a pending
      // APPROVAL question is: auto-answering a question that is already on screen would
      // answer it behind the user's back, so the toggle is plain state, applying to the
      // next call rather than the one being asked about.
      const rec = open(sessionId);
      await rec.session.emit({ type: 'accept-edits.mode-changed', turnId: rec.session.turnId, enabled, by: 'user' });
    },

    respondPlan(sessionId: string, callId: string, choice: number | null, reason: string | null): Promise<void> {
      const rec = open(sessionId);
      const answer: PlanChoice =
        choice === null ? { kind: 'none', reason: reason ?? '' } : { kind: 'chosen', index: choice };
      const pending = rec.pendingPlan;
      if (pending !== null && pending.callId === callId) {
        rec.pendingPlan = null;
        pending.resolve(answer);
        return Promise.resolve();
      }
      // Same seam as `earlyApprovals`: the event lands before the bridge is consulted,
      // so an answer that arrives first is held, not refused.
      if (rec.earlyPlanReplies.size >= MAX_EARLY_APPROVALS) {
        return Promise.reject(
          new ProtocolHostError(`too many plan replies arrived before the kernel asked for call ${callId}`, ERROR_CODES.hostRefused, {
            sessionId,
            callId,
          }),
        );
      }
      rec.earlyPlanReplies.set(callId, answer);
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
      try {
        hostClosed = true;
        if (cronTimer !== null) clearInterval(cronTimer);
        mcpLifetime.abort();
        await mcp.close();
        // Abort the turns first: a turn stopped between `tool.finished` and
        // `tool.background.started` still has a start to record, and its task's exit is
        // waiting for that record. Only then stop the tasks and drain the writes.
        for (const rec of sessions.values()) {
          for (const queued of rec.queue) queued.controller.abort();
          rec.queue.length = 0;
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
      } finally {
        // Abandon open spans first (so their end timestamps precede the exporter
        // flush), then best-effort flush — the 1s budget lives in the handle. This
        // runs even when a session close threw above: a teardown failure must not
        // leak the provider or leave spans unended.
        if (spanTap !== null) spanTap.finish(Date.now());
        if (telemetry !== null) await telemetry.finish();
      }
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
  return new Promise<ApprovalVerdict>((resolve) => {
    // The kernel asks serially, one question per turn segment: a new ask means the
    // previous wait was abandoned upstream (timeout, cancel) and its stale entry is a
    // corpse, not a concurrency bug. Replacing it is what keeps a timed-out question
    // from refusing every later one in the same turn (review of #167, P0-1).
    if (rec.pendingApproval !== null) {
      rec.pendingApproval = null;
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

/**
 * The plan-review twin of {@link askApproval} (ADR-125 ③): same pairing rule, same
 * one-question-at-a-time invariant, same early-answer seam, and the same stale-entry
 * replacement (see askApproval — a timed-out review must not veto the model's retry).
 * The plans themselves travel in the `plan.proposed` event the frontend already saw —
 * the bridge only pairs the answer back to the waiting call.
 */
function askPlanReview(rec: SessionRecord, callId: string): Promise<PlanChoice> {
  return new Promise<PlanChoice>((resolve) => {
    if (rec.pendingPlan !== null) {
      rec.pendingPlan = null;
    }
    const early = rec.earlyPlanReplies.get(callId);
    if (early !== undefined) {
      rec.earlyPlanReplies.delete(callId);
      resolve(early);
      return;
    }
    rec.pendingPlan = { callId, resolve };
  });
}

interface ChangeOperation {
  readonly callId: string;
  readonly path: string;
  readonly beforePath: string;
  readonly created: boolean;
  readonly beforeHash: string | null | undefined;
  readonly afterHash: string | null | undefined;
  readonly undone: boolean;
  readonly redoPath: string | null;
}

function latestChange(events: readonly KernelEvent[], undone: boolean): ChangeOperation | null {
  const operations = new Map<string, ChangeOperation>();
  let latest: ChangeOperation | null = null;
  for (const event of events) {
    if (event.type === 'file.changed') {
      latest = {
        callId: event.callId,
        path: event.path,
        beforePath: event.beforePath,
        created: event.created,
        beforeHash: event.beforeHash,
        afterHash: event.afterHash,
        undone: false,
        redoPath: null,
      };
      operations.set(event.callId, latest);
    } else if (event.type === 'file.reverted') {
      const operation = operations.get(event.callId);
      if (operation !== undefined) {
        latest = { ...operation, undone: true, redoPath: event.redoPath };
        operations.set(event.callId, latest);
      }
    } else if (event.type === 'file.restored') {
      const operation = operations.get(event.callId);
      if (operation !== undefined) {
        latest = { ...operation, undone: false, redoPath: null };
        operations.set(event.callId, latest);
      }
    }
  }
  if (undone) return latest !== null && latest.undone ? latest : [...operations.values()].reverse().find((operation) => operation.undone) ?? null;
  return [...operations.values()].reverse().find((operation) => !operation.undone) ?? null;
}

async function promptAttachments(files: readonly string[] | undefined, sessionId: string): Promise<readonly AttachedFile[]> {
  if (files === undefined || files.length === 0) return [];
  if (files.length > PROMPT_FILE_MAX_COUNT) {
    throw new ProtocolHostError(`too many @ files: ${String(files.length)} (at most ${String(PROMPT_FILE_MAX_COUNT)})`, ERROR_CODES.hostRefused, { sessionId });
  }
  const attached: AttachedFile[] = [];
  const seen = new Set<string>();
  for (const path of files) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      attached.push(await readPromptFile(path));
    } catch (error) {
      const why = error instanceof PromptFileError ? error.message : String(error);
      throw new ProtocolHostError(`@文件 ${path}：${why}`, ERROR_CODES.hostRefused);
    }
  }
  return attached;
}

function standingGrants(events: readonly KernelEvent[]): readonly { readonly id: string; readonly key: string; readonly verdict: 'always' | 'session' }[] {
  const grants = new Map<string, { readonly id: string; readonly key: string; readonly verdict: 'always' | 'session' }>();
  for (const event of events) {
    if (event.type === 'approval.answered' && (event.verdict === 'always' || event.verdict === 'session') && !grants.has(event.key)) {
      grants.set(event.key, { id: `grant_${String(event.seq)}`, key: event.key, verdict: event.verdict });
    } else if (event.type === 'approval.revoked') {
      grants.delete(event.key);
    }
  }
  return [...grants.values()];
}

/**
 * The replayable body of a logged event: everything `emit` re-mints itself. Deleting
 * rather than destructuring: the linter reads an unused destructure as dead code, and
 * a fresh object here is one copy of a small record, not a hot path.
 */
function stripEventIds(event: KernelEvent): EventInput {
  const clone: Record<string, unknown> = { ...event };
  delete clone.seq;
  delete clone.ts;
  delete clone.sessionId;
  return clone as unknown as EventInput;
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
  /** The host's job table (ADR-140). `undefined` means cron is off in this build — the
   *  tools refuse by their absence, exactly the background precedent (ADR-143 ④). */
  readonly cron: CronTasksPort | undefined;
  /** The clock CronDelete stamps deletions with (tests fake it via options.clock). */
  readonly now: () => number;
  /** Trusted, visible skills; empty means no `Skill` tool is offered at all (ADR-117 ①). */
  readonly skills: readonly SkillFile[];
  /** User-level memory targets live under `~/.cowcat` (ADR-135). */
  readonly home: string;
  /** The startup trust snapshot; gates *-project Remember targets (ADR-136 ②). */
  readonly workspaceTrusted: boolean;
  /** Lazy vision endpoint for the View tool (ADR-138 ③); throwing is the contract. */
  readonly vision: () => { readonly port: ModelPort; readonly model: string };
}): ReadonlyMap<string, ToolPort> {
  const tools: readonly ToolPort[] = [
    createReadTool({ cwd: options.cwd, spill: options.spill }),
    createWriteTool({ cwd: options.cwd, checkpoints: { rootDir: options.spill.rootDir } }),
    createEditTool({ cwd: options.cwd, checkpoints: { rootDir: options.spill.rootDir } }),
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
    createRememberTool({ cwd: options.cwd, home: options.home, trusted: options.workspaceTrusted }),
    createViewTool({ cwd: options.cwd, vision: options.vision }),
    // No cron port, no cron tools: "this build has no scheduled tasks" is a capability
    // statement, and the absence keeps the model from calling what does not exist.
    ...createCronTools({ cron: options.cron, now: options.now }),
    // No skills, no tool: an empty `Skill` would only tell the model what is not there.
    ...(options.skills.length === 0 ? [] : [createSkillTool({ skills: options.skills })]),
  ];
  return new Map(tools.map((tool) => [tool.spec.name, tool]));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
