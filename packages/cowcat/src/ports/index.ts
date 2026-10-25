import type { KernelEvent } from '../kernel/events.js';
import type { Message, ReasoningBlock, ToolCall } from '../kernel/messages.js';
import type { SessionState } from '../kernel/state.js';
import type { Attachment } from './attachments.js';
import type { BackgroundTaskRef } from './background.js';
import type { CronCreatedRef } from './cron.js';
import type { ModelUsage, StopReason } from './model.js';
import type { ExecutionFacts } from './process.js';

// The ports live in their own files (docs/architecture/01-layers.md) and are
// re-exported here, so this barrel stays the single import surface for the kernel
// and the tests.
export * from './attachments.js';
export * from './audit.js';
export * from './background.js';
export * from './cron.js';
export * from './fs.js';
export * from './hooks.js';
export * from './instructions.js';
export * from './model.js';
export * from './platform.js';
export * from './process.js';
export * from './skills.js';
export * from './subagent.js';
export * from './trust.js';

export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One item of the session's todo list (ADR-054).
 *
 * `content` is imperative ("Add input validation"), `activeForm` is the present
 * continuous of the same task ("Adding input validation") — the pair is what lets a
 * frontend show what is being worked on without rewriting the model's words.
 */
export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly activeForm: string;
}

/**
 * What a cap left out of a tool's output (ADR-048).
 *
 * The arithmetic is the gateway's, not a second one: `dropped` is the amount that is
 * missing, never an independent running total, so it cannot drift from what was kept
 * (`adapters/output-tail.ts` records the same lesson for process output).
 *
 * This is a structured fact rather than an in-band `[truncated]` note because the same
 * omission has two readers with two renderings: the model reads the note the tool put
 * in `output`, and an audit reads this field.
 */
export interface Truncation {
  /**
   * True when a cap removed something. `false` is a real answer — "asked, nothing was
   * dropped" — and is different from `ToolResult` reporting no `truncation` at all.
   */
  readonly truncated: boolean;
  /**
   * How much is missing, in the unit `reason` names. Always `total - kept` — and
   * `null` when the producer stopped early and the total is therefore unknown, which
   * is the whole point of stopping early (ADR-053). `0` still means "asked, nothing
   * was dropped"; it never stands in for "not counted".
   */
  readonly dropped: number | null;
  /**
   * Which cap applied, in words an audit can print (`read: 2000 lines`), or `null` when
   * nothing was dropped. It names the unit `dropped` counts in, because different tools
   * cap different things (lines, matches, characters).
   */
  readonly reason: string | null;
}

/**
 * What the kernel granted for THIS call, and nothing else (ADR-051).
 *
 * The verdict is decided per call inside `runTurn`, so a tool cannot read it from
 * configuration; this is the carrier. Only the grant belongs here — no rules, no
 * opinions — mirroring `ToolResult.facts`, where the tool reports back what it actually
 * did.
 */
export interface ToolGrant {
  /**
   * True only when the user's `once`/`always` answer granted network for this call,
   * including a standing `always` from earlier in the same session.
   *
   * `false` means "no grant was given for this call"; it does **not** mean network is
   * off. A tool whose sandbox profile asks for network must therefore refuse and say so
   * rather than quietly treating `ask` as `off` (ADR-051, ADR-016).
   */
  readonly networkApproved: boolean;
  /**
   * True only when an approved Escalate appeal lets THIS call run without the sandbox
   * (ADR-130). Once-only by construction: the kernel burns the `once` grant when it
   * hands this grant out, so a tool never sees the same waiver twice. A tool that
   * cannot run unsandboxed must refuse and say so — the same honesty rule
   * `networkApproved` follows.
   */
  readonly unsandboxedApproved: boolean;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  /**
   * JSON Schema for the tool's input as a model needs to see it, or absent when the
   * tool declares none. Producers are P5's job (turning a tool's zod schema into JSON
   * Schema is one of P5's research questions); an adapter needs a place to read it
   * from, because a tool declared without parameters is a tool a model cannot call
   * correctly.
   */
  readonly inputSchema?: unknown;
  /**
   * Input field names that carry the two things a rule may narrow on. The kernel
   * reads them to build the `ActionRequest` (ADR-027) — a tool that writes a file
   * says `pathInput: 'file_path'`, one that runs a command says
   * `commandInput: 'command'`. Absent means the action has no path/command, so a
   * rule that selects on one simply does not match.
   *
   * Kept as two field names rather than a per-tool descriptor method so the
   * declaration stays data: the risk level is declared the same way, and the
   * kernel can read it without knowing any particular tool.
   */
  readonly pathInput?: string;
  readonly commandInput?: string;
}

export interface FileCheckpoint {
  readonly path: string;
  readonly beforePath: string;
  readonly created: boolean;
  readonly beforeHash: string | null;
  readonly afterHash?: string | null;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly checkpoint?: FileCheckpoint;
  /**
   * Set when this call started a task that outlives it (ADR-111). The kernel turns it into
   * `tool.background.started`; the task itself lives in the host's registry, not here.
   */
  readonly background?: BackgroundTaskRef;
  /**
   * Set when this call created a cron job (ADR-140). The kernel turns it into
   * `cron.created`; the job table is the host's projection of those events, not
   * something this result carries. Same direction as `background`.
   */
  readonly cronCreated?: CronCreatedRef;
  /**
   * Set when this call deleted a cron job (ADR-140). The kernel turns it into
   * `cron.deleted` with `by: 'model'`; the host's own deletions (the `/cron` panel)
   * go through `Session.cronDeleted` directly.
   */
  readonly cronDeleted?: { readonly jobId: string; readonly deletedAt: number };
  /**
   * True when the sandbox REFUSED this run (ADR-130 ①): the backend could not satisfy
   * the request or is unavailable, and the tool reported it instead of degrading.
   * The kernel keeps a without-sandbox appeal honest with it — Escalate is offered
   * for a subject the sandbox actually refused. Absent on every older result: no
   * opinion, exactly like `facts`.
   */
  readonly sandboxRefused?: boolean;
  /**
   * What the execution gateway actually did, when this tool ran a process
   * (ADR-033). Absent means the tool reported NOTHING — which an audit has to record
   * as "not known", never as "no sandbox". The difference between those two is the
   * whole point of an audit trail.
   */
  readonly facts?: ExecutionFacts;
  /**
   * What a cap left out of `output` (ADR-048). Absent means the tool reported NOTHING —
   * the same statement `facts` makes and for the same reason: "this tool does not
   * truncate" and "nobody said" are different facts, and only one of them is true here.
   */
  readonly truncation?: Truncation;
  /**
   * The session's todo list as this call leaves it (ADR-054), or absent for a tool that
   * has no such list.
   *
   * The tool reports the list it declared; it does not hold one. `runTurn` turns this
   * into the `todo.updated` event, which is what makes the list survive a reopened
   * session — the same direction `facts` and `truncation` travel.
   */
  readonly todos?: readonly TodoItem[];
  /**
   * Binary content this call hands to the model (ADR-057), or absent for a tool that
   * produced none.
   *
   * `runTurn` turns this into the `tool.finished` event's `attachments`, which is what
   * makes "this answer came with an image" a replayable fact rather than something the
   * next process has to rediscover. The entries are references; the bytes stay on disk.
   */
  readonly attachments?: readonly Attachment[];
}

export interface ToolRunContext {
  /** Which session owns this call. Only tools that outlive the call need it (ADR-111). */
  readonly sessionId: string;
  /** Which call this is: the id the log and the frontend key on. */
  readonly callId: string;
  /** Where live output goes while the call runs (ADR-108). Absent means nobody is watching. */
  readonly onOutput?: ToolOutputListener;
}

export interface ToolPort {
  readonly spec: ToolSpec;
  /**
   * `grant` describes what the kernel granted for this call (ADR-051). It is required
   * rather than optional so an implementation has to decide what it does with an `ask`
   * profile instead of silently ignoring it.
   *
   * `context` is what the call is allowed to know about its surroundings (ADR-108/111):
   * the live-output listener, and the ids a tool needs to start work that outlives the
   * call. The kernel closes over them, so no tool ever reaches into a session.
   */
  run(input: unknown, signal: AbortSignal, grant: ToolGrant, context?: ToolRunContext): Promise<ToolResult>;
}

export type ToolOutputStream = 'stdout' | 'stderr';

/**
 * A live fragment of a tool's output, for the screen only (ADR-108).
 *
 * Same shape as `ProcessPort`'s sink on purpose: the Bash tool forwards one to the other
 * without inventing a third vocabulary.
 */
export type ToolOutputListener = (stream: ToolOutputStream, text: string) => void;

export type ModelChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | {
      /**
       * A live fragment of the reasoning, for the screen only (ADR-098).
       *
       * The complete blocks below are what the kernel records and replays; this channel
       * exists because "the model is thinking" has to be visible while it happens, and
       * Anthropic only closes a thinking block at `content_block_stop`.
       */
      readonly type: 'reasoning.delta';
      readonly text: string;
    }
  | {
      /**
       * One complete reasoning block (ADR-045), emitted the way `tool_call` is and for
       * the same reason: a chunk is a fact the kernel records, and a fragment is not.
       *
       * "Complete" is what makes replay possible — Anthropic's thinking blocks carry an
       * opaque signature that arrives at the END of the block (`signature_delta`, just
       * before `content_block_stop`), and the block has to be sent back with it, in
       * order, unmodified. Emitting per delta would make that impossible to reconstruct.
       *
       * Live rendering of the reasoning as it arrives is a different concern and is not
       * this channel: `StreamDelta` is where ephemeral display goes, and P6 owns it.
       */
      readonly type: 'reasoning';
      readonly block: ReasoningBlock;
    }
  | {
      /**
       * Emitted when the adapter has numbers to report, which is not the same as
       * "once per stream": most streaming chunks carry no usage at all, and Anthropic
       * reports it twice (an initial count, then a cumulative one). A consumer that
       * wants a single figure takes the last one (ADR-040).
       */
      readonly type: 'usage';
      readonly usage: ModelUsage;
    }
  | {
      /**
       * What the stream ended on. Deliberately NOT what decides that the stream has
       * ended: providers disagree about whether a usage-only chunk or `[DONE]`
       * follows the finishing chunk, and some keep sending tool-call deltas after it
       * (`agent/src/llm/openai.js:69-71`). The end of the iterator is the end.
       */
      readonly type: 'stop';
      readonly reason: StopReason;
    };

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  /**
   * Images that ride the FIRST user message as content parts — the direct-call
   * channel (ADR-139). The conversation path does not use this: there, images travel
   * as tool-result attachments and the adapters materialize them (ADR-057). The two
   * channels do not meet in today's consumers; View is the first and only caller.
   */
  readonly images?: readonly Attachment[];
  /**
   * Which model to call. The kernel knows it, because "which model" is a decision the
   * session made, not something an adapter may guess (ADR-035).
   */
  readonly model: string;
  /**
   * Instructions that go ahead of the conversation. A request field rather than a
   * `Message`, because the two protocols disagree about where it lives: Anthropic
   * takes a top-level `system`, OpenAI takes a `role: 'system'` message — and the
   * internal `Message` union has no such role (ADR-035).
   */
  readonly system?: string;
  /** An override; a model's own ceiling comes from its preset (ADR-037). */
  readonly maxTokens?: number;
  /**
   * Vendor extensions (ADR-038). A named escape hatch rather than a free-form bag on
   * the request itself; an adapter sends only what a preset declared, because guessing
   * a default either 400s (MiniMax rejects `reasoning_effort: 'none'`) or is silently
   * ignored.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

export interface EventStore {
  append(event: KernelEvent): Promise<void>;
  readAll(sessionId: string): Promise<readonly KernelEvent[]>;
  /**
   * The first event of a log, or null when the log is absent or empty. Exists so a
   * consumer can read the session header (ADR-126) without paying for the whole log:
   * the telemetry tap primes the provider name from it at adopt time, and open needs
   * the header anyway — a second full read per adoption would double open's IO.
   */
  readHeader(sessionId: string): Promise<KernelEvent | null>;
  /**
   * Best-effort log removal; exists for the fork cleanup path (ADR-127). Optional
   * because the port's contract is append/read — a store without it simply leaves
   * a half-born fork on disk, loud at open time rather than silent.
   */
  remove?(sessionId: string): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface IdSource {
  next(prefix: string): string;
}

// A session is single-writer, and the lock is held for the whole life of the
// Session — not for the duration of a single append (ADR-010). `EventStore` stays
// unaware of it: the lock is a separate port so a memory store need not fake it.
export interface SessionLock {
  release(): Promise<void>;
}

export interface LockPort {
  acquire(sessionId: string): Promise<SessionLock>;
}

// Snapshots accelerate replay; they are never a source of truth. `load` answers null
// when there is no snapshot *or* when it cannot be used, because both mean the same
// thing to the caller: replay the log (ADR-013).
export interface SessionSnapshot {
  readonly schemaVersion: number;
  readonly lastSeq: number;
  readonly state: SessionState;
}

export interface SnapshotPort {
  load(sessionId: string): Promise<SessionSnapshot | null>;
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;
}

// Thrown when acquire() cannot claim the session. The fields let a frontend render
// recovery guidance without parsing the message. Ports deliberately expose no
// "is it locked?" query: callers must go through acquire, not around it.
export class LockHeldError extends Error {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly lockPath: string;
  readonly guidance: string;

  constructor(sessionId: string, lockPath: string, pid: number | null, guidance: string) {
    super(`session ${sessionId} is locked: ${guidance}`);
    this.name = 'LockHeldError';
    this.sessionId = sessionId;
    this.pid = pid;
    this.lockPath = lockPath;
    this.guidance = guidance;
  }
}
