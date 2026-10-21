import { approvalKey, toolGrantKey, type ApprovalBy, type ApprovalVerdict } from '../policy/approval.js';
import { assessCommand } from '../policy/command-risk.js';
import { decide, type ActionRequest, type Decision, type Rule } from '../policy/decide.js';
import type { FsPort, IdSource, ModelPort, ModelRequest, StopReason, SubagentOutcome, SubagentPort, ToolGrant, ToolPort, ToolResult, ToolRisk, ToolSpec } from '../ports/index.js';
import type { InstructionPort } from '../ports/index.js';
import { decideInstruction, describeInstructionSkip } from '../policy/instructions.js';
import { TASK_SPEC, TASK_TOOL_NAME, clipReport, formatTaskResult, parseTaskInput, type TaskInput } from './subagent.js';
import type { ReasoningBlock, ToolCall } from './messages.js';
import { compactContext } from './compact.js';
import { contextCeiling, contextUsage } from './context.js';
import type { ModelPreset } from './preset.js';
import type { Session } from './session.js';
import { isTerminal, type TerminalTurnState } from './turn.js';

/**
 * How long an approval may wait before it is refused (ADR-032).
 *
 * A timeout is a rejection, not an error: unattended work has to end in a recorded
 * refusal rather than in an approval nobody gave. Five minutes because a person
 * reading a diff or a command needs to be able to think, and an agent that treats a
 * pause as a no would be unusable interactively.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export interface InstructionNeeds {
  /** Reads the chain (ADR-076). */
  readonly port: InstructionPort;
  /** The directory whose chain applies. */
  readonly cwd: string;
  /** Whether this workspace is trusted (ADR-030/077). */
  readonly trust: { readonly trusted: boolean };
  /** The user-global file, if the host has one (ADR-075). */
  readonly global?: string;
  /** Overrides INSTRUCTION_MAX_BYTES (ADR-076). */
  readonly maxBytes?: number;
}

export interface TurnDeps {
  readonly session: Session;
  readonly model: ModelPort;
  /**
   * The model this turn calls, as data (ADR-046 decision ①): the id, the response
   * ceiling, whether tools may be sent, and the wire parameters behind each reasoning
   * level. A preset rather than an id, because "which model" and "what it can do" are
   * one decision — held by the kernel because that decision belongs to the session, not
   * to an adapter that would have to guess (ADR-035).
   */
  readonly preset: ModelPreset;
  /**
   * The reasoning level the caller asked for, when it asked at all (ADR-046 decision ④).
   * What a level means is the preset's data: the kernel looks up whether the level was
   * declared, relays those parameters verbatim, and reports an undeclared level instead
   * of sending anything.
   */
  readonly effort?: string;
  readonly tools: ReadonlyMap<string, ToolPort>;
  readonly rules: readonly Rule[];
  /**
   * Path identity (ADR-017). The kernel needs it for one thing: turning the path a
   * tool call names into the canonical spelling a rule compares against. It is a
   * port, so the kernel still touches no host runtime.
   */
  readonly fs: FsPort;
  /**
   * Asks whoever is in front of the session. The answer is a verdict, not a boolean:
   * `once` and `always` both let the call run but mean different things afterwards
   * (ADR-031 decision 2).
   */
  readonly approve: (request: ActionRequest, decision: Decision) => Promise<ApprovalVerdict>;
  /** Overrides DEFAULT_APPROVAL_TIMEOUT_MS. Tests use a short one. */
  readonly approvalTimeoutMs?: number;
  readonly ids: IdSource;
  /**
   * Where workspace instructions come from, when the caller has them (ADR-078). Omitted
   * means the session runs without them, which is what a kernel test wants: no
   * filesystem, no injection.
   */
  readonly instructions?: InstructionNeeds;
  /**
   * The most model rounds this turn may take (ADR-082 ②), or unlimited when omitted.
   *
   * A delegated child sets this from the `max_turns` the parent asked for. Hitting the
   * cap is a normal ending with `partial: true`, not an error: the work that was done is
   * still work, and upstream reports it the same way.
   */
  readonly maxRounds?: number;
  /**
   * Runs delegated tasks (ADR-079/080). Omitted means `Task` is not put on the wire at
   * all — which is exactly how a child session is kept from delegating further: its
   * `TurnDeps` simply has no port (ADR-081 ④).
   */
  readonly subagents?: { readonly port: SubagentPort };
  /**
   * Why nobody can answer an approval in this session (ADR-081 ③).
   *
   * When set, every `ask` is refused immediately and recorded as `by: 'unattended'`.
   * The alternative — asking and waiting — costs the approval timeout (ADR-032) to learn
   * that there was no reader, which is the worst of the three outcomes.
   */
  readonly unattended?: string;
}

/**
 * A static fact the run worked under, not something the run observed (ADR-046
 * decisions ③/④), plus the run-time outcomes that have to be reported rather than
 * thrown (ADR-072, ADR-082). They ride the outcome for callers that reason about the
 * run, and `runTurn` also records each one as a `turn.noted` event (ADR-093) so a
 * frontend that only sees the log still learns about it.
 */
export type TurnNote =
  | { readonly kind: 'tools-unsupported'; readonly model: string }
  | { readonly kind: 'effort-not-declared'; readonly model: string; readonly effort: string }
  /**
   * A compaction that should have run did not (ADR-072). Reported rather than thrown,
   * because the turn can still continue on the history it already has.
   */
  | { readonly kind: 'compaction-failed'; readonly reason: string }
  /**
   * Instructions were found but not injected (ADR-030/077). Reported so the user learns
   * the workspace's rules are not in play — the notice is the point, not the absence.
   */
  | { readonly kind: 'instructions-skipped'; readonly reason: string }
  /**
   * The delegation cap stopped the turn with work still to do (ADR-082 ②). Reported
   * rather than thrown: the rounds that ran produced real results, and the caller needs
   * to know the answer is partial before handing it to a model as final.
   */
  | { readonly kind: 'rounds-exhausted'; readonly rounds: number };

export interface TurnOutcome {
  /**
   * The turn this run opened (ADR-064).
   *
   * `runTurn` mints it, so a caller that needs to answer "which turn is this?" — the
   * protocol's `turn.send` does — would otherwise have to watch the event stream to find
   * out. It is the same id the log's `turn.opened` carries, and it is reported whether
   * the turn completed, failed or was cancelled.
   */
  readonly turnId: string;
  readonly state: TerminalTurnState;
  readonly reason: string | null;
  /**
   * True when `maxRounds` stopped the turn (ADR-082 ②). A partial answer is still an
   * answer, but a caller must not present it as "the model finished".
   */
  readonly partial: boolean;
  /** Empty in the common case; see TurnNote. */
  readonly notes: readonly TurnNote[];
}

class TurnAborted extends Error {}

export async function runTurn(deps: TurnDeps, input: string, signal: AbortSignal): Promise<TurnOutcome> {
  const notes: TurnNote[] = [];
  const outcome = await runTurnBody(deps, input, signal, notes);
  return { ...outcome, notes };
}

/**
 * Records a note as an event at the moment it happens (ADR-093).
 *
 * Eagerly, not at the end: a frontend that stops reading when the turn completes
 * (`run` unsubscribes on the terminal transition) would otherwise miss a notice written
 * after it — which is exactly what the first end-to-end check found. Writing it now also
 * keeps the log's order honest: the skip is a fact about the turn that is about to run,
 * not an epilogue to it.
 *
 * Failure to write is swallowed: a log that cannot take the notice must not turn a
 * finished turn into a failed one — the same rule compaction follows for its own failure
 * (ADR-072 ④).
 */
async function recordNote(
  deps: TurnDeps,
  notes: TurnNote[],
  note: TurnNote,
  turnId: string | null,
): Promise<void> {
  notes.push(note);
  try {
    await deps.session.emit({
      type: 'turn.noted',
      // Null before `turn.opened`: a note about the configuration the turn will run
      // under has no turn yet, and the union says so rather than inventing one.
      turnId,
      note: note.kind,
      message: describeTurnNote(note),
    });
  } catch {
    // A closed session is the ordinary way this fails; the turn's outcome is unaffected.
  }
}

/** The one-line rendering. Kernel-side so every frontend shows the same words. */
export function describeTurnNote(note: TurnNote): string {
  switch (note.kind) {
    case 'tools-unsupported':
      return `模型 ${note.model} 不支持工具调用，本回合没有工具可用`;
    case 'effort-not-declared':
      return `preset 没有声明 effort「${note.effort}」，已按默认发送`;
    case 'compaction-failed':
      return `上下文压缩失败：${note.reason}（回合继续，历史未被替换）`;
    case 'instructions-skipped':
      return `工作区指令未注入：${note.reason}`;
    case 'rounds-exhausted':
      return `达到回合上限（${String(note.rounds)} 轮），结果不完整`;
  }
}

async function runTurnBody(
  deps: TurnDeps,
  input: string,
  signal: AbortSignal,
  notes: TurnNote[],
): Promise<Omit<TurnOutcome, 'notes'>> {
  const { session } = deps;
  const effort = wireEffort(deps.preset, deps.effort);
  const note = async (item: TurnNote, turnId: string | null): Promise<void> => {
    await recordNote(deps, notes, item, turnId);
  };
  // Computed once, before anything can fail: they describe the configuration the run
  // works under, so every exit carries them (ADR-046).
  if (!deps.preset.toolCalls) await note({ kind: 'tools-unsupported', model: deps.preset.model }, null);
  if (effort.note !== null) await note(effort.note, null);

  // Instructions go in **before** the turn opens, so the model reads the repository's
  // rules ahead of the request rather than after it (ADR-078 ①).
  await ensureInstructions(deps, (item) => note(item, null));
  await session.openTurn(input);
  const turnId = session.turnId;
  if (turnId === null) throw new Error('the session did not open a turn');
  // One automatic compaction check per turn (ADR-073): the history only grows while the
  // turn runs, and a second attempt after a failure would retry a call that just failed.
  let compactionChecked = false;
  // Model calls made so far; the delegation cap counts these, not tool calls (ADR-082 ②).
  let rounds = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new TurnAborted('aborted before the model was called');
      if (!compactionChecked) {
        compactionChecked = true;
        const ceiling = contextCeiling(deps.preset.limits.context);
        if (ceiling !== null && contextUsage(session.state).total > ceiling) {
          const outcome = await compactContext(
            {
              session,
              model: deps.model,
              preset: deps.preset,
              tools: deps.preset.toolCalls ? [...deps.tools.values()].map((tool) => tool.spec) : [],
            },
            'auto',
            signal,
          );
          if (!outcome.ok && outcome.reason !== null) await note({ kind: 'compaction-failed', reason: outcome.reason }, turnId);
          // A compaction shadows the instruction message, so the fix is to put it back
          // (ADR-078 ①) — in the same turn, before the next request goes out.
          await ensureInstructions(deps, (item) => note(item, turnId));
        }
      }
      if (deps.maxRounds !== undefined && rounds >= deps.maxRounds) {
        // The cap is a normal ending: finishing → completed, with the caller told the
        // answer is partial rather than being handed a silent truncation.
        await note({ kind: 'rounds-exhausted', rounds }, turnId);
        await session.transition('finishing');
        await session.transition('completed');
        return { turnId, state: 'completed', reason: null, partial: true };
      }
      const calls = await streamModel(deps, effort.providerOptions, signal);
      rounds += 1;
      if (calls.length === 0) {
        await session.transition('finishing');
        await session.transition('completed');
        return { turnId, state: 'completed', reason: null, partial: false };
      }
      await session.transition('awaiting_tools');
      for (const call of calls) {
        const { result, path } = await runCall(deps, call, signal);
        // Before `tool.finished` on purpose (ADR-054): two appends are never atomic, and
        // the two directions are not equal — a crash here leaves the list recorded, while
        // the other order would lose the user-visible state and still claim success.
        if (result.ok && result.todos !== undefined) {
          await session.emit({ type: 'todo.updated', turnId: session.turnId, todos: result.todos });
        }
        await session.emit({
          type: 'tool.finished',
          turnId: session.turnId,
          callId: call.callId,
          name: call.name,
          ok: result.ok,
          output: result.output,
          // Passed through, not invented: a tool that reported no facts contributes
          // `null`, so the audit can tell "not known" from "nothing applied".
          facts: result.facts ?? null,
          // Same rule for truncation: `null` = not reported (ADR-048).
          truncation: result.truncation ?? null,
          // And for attachments: `null` = the tool produced no binary content (ADR-057).
          attachments: result.attachments ?? null,
          // The canonical path from the request that was decided on (ADR-049).
          path,
        });
      }
      await session.transition('requesting');
    }
  } catch (error) {
    const aborted = error instanceof TurnAborted || signal.aborted;
    const outcome: TerminalTurnState = aborted ? 'cancelled' : 'failed';
    const reason = error instanceof Error ? error.message : String(error);
    const turn = session.state.turn;
    if (turn !== null && !isTerminal(turn.state)) await session.transition(outcome, reason);
    return { turnId, state: outcome, reason, partial: false };
  }
}

interface EffortWiring {
  readonly providerOptions: Readonly<Record<string, unknown>> | undefined;
  readonly note: TurnNote | null;
}

// "Did the preset declare this level?" is the kernel's whole involvement (ADR-046
// decision ④): the parameters are data, relayed as-is, and an unknown level is reported
// and skipped — the same "report and skip" shape the policy layer uses for rules.
// Own properties only: a level named `toString` is a request the preset did not answer,
// not a declaration inherited from `Object.prototype`.
function wireEffort(preset: ModelPreset, effort: string | undefined): EffortWiring {
  if (effort === undefined) return { providerOptions: undefined, note: null };
  const efforts = preset.efforts;
  const declared = efforts !== undefined && Object.hasOwn(efforts, effort) ? efforts[effort] : undefined;
  if (declared === undefined) {
    return { providerOptions: undefined, note: { kind: 'effort-not-declared', model: preset.model, effort } };
  }
  return { providerOptions: declared, note: null };
}

/**
 * Make sure the model's history carries the workspace instructions (ADR-078).
 *
 * Called once before a turn opens, and again right after a compaction. Doing nothing
 * when `instructionsSeq` is set **is** the dedupe — the fold decides, not a counter in
 * memory, so a reopened session does not inject a second copy either.
 */
async function ensureInstructions(
  deps: TurnDeps,
  note: (item: TurnNote) => Promise<void>,
): Promise<void> {
  const needs = deps.instructions;
  if (needs === undefined) return;
  if (deps.session.state.instructionsSeq !== null) return;

  try {
    const files = await needs.port.chain(needs.cwd, needs.global === undefined ? {} : { global: needs.global });
    const decision = decideInstruction(files, needs.trust, needs.maxBytes);
    if (decision.kind === 'none') return;
    if (decision.kind === 'skipped-untrusted') {
      const reason = describeInstructionSkip(decision);
      if (reason !== null) await note({ kind: 'instructions-skipped', reason });
      return;
    }
    const encoder = new TextEncoder();
    await deps.session.emit({
      type: 'instructions.loaded',
      turnId: deps.session.turnId,
      // `start` for the first injection of the session; every later one is a refresh
      // after a compaction shadowed the previous message.
      trigger: deps.session.state.instructionsCount === 0 ? 'start' : 'refresh',
      text: decision.text,
      files: decision.files.map((file) => ({ path: file.path, bytes: encoder.encode(file.content).length })),
    });
  } catch (error) {
    // Instructions are guidance. A broken read is reported, never fatal — the same rule
    // compaction follows (ADR-072 ④).
    await note({ kind: 'instructions-skipped', reason: error instanceof Error ? error.message : String(error) });
  }
}

async function streamModel(
  deps: TurnDeps,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal,
): Promise<readonly ToolCall[]> {
  const { session, model, preset } = deps;
  const turnId = session.turnId;
  if (turnId === null) throw new Error('streamModel outside a turn');

  const request: ModelRequest = {
    messages: session.state.messages,
    // The preset's `toolCalls` gates the one place tools are put on the wire; a model
    // that cannot take them runs the same turn without (ADR-046 decision ③).
    tools: preset.toolCalls ? wireTools(deps) : [],
    model: preset.model,
    ...(preset.limits.output === undefined ? {} : { maxTokens: preset.limits.output }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
  await session.transition('streaming');

  let text = '';
  let stopReason: StopReason | null = null;
  const calls: ToolCall[] = [];
  const reasoning: ReasoningBlock[] = [];
  for await (const chunk of model.stream(request, signal)) {
    switch (chunk.type) {
      case 'text':
        text += chunk.text;
        session.streamDelta(chunk.text);
        break;
      case 'tool_call':
        calls.push(normalizeCall(chunk.call));
        break;
      case 'reasoning':
        // Kept exactly as it arrived — block, signature and all (ADR-045). Nothing here
        // may normalise it: a modified block cannot be replayed, and which fields the
        // protocol needs back is the adapter's knowledge, not the kernel's.
        reasoning.push(chunk.block);
        break;
      case 'usage':
        // Written when it arrives rather than held until the turn ends: usage that has
        // already been billed has to survive a cancellation (ADR-041).
        await session.emit({ type: 'model.usage', turnId, usage: chunk.usage });
        break;
      case 'stop':
        // The last one wins, and it never ends the loop — the end of the iterator is
        // the end, because providers disagree about what follows a finishing chunk.
        stopReason = chunk.reason;
        break;
      default: {
        // A new chunk type has to be handled here rather than silently dropped in the
        // one place that turns chunks into facts.
        const unhandled: never = chunk;
        throw new Error(`unhandled model chunk: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  if (signal.aborted) throw new TurnAborted('aborted while streaming');

  await session.emit({ type: 'model.message', turnId, text, toolCalls: calls, reasoning, stopReason });
  return calls;
}

// The tools a request carries: the registered ones, plus the one the kernel answers
// itself (ADR-080 ③). Built in one place so `compaction`'s subordinate call — which
// passes `deps.tools` directly — cannot accidentally offer `Task` to a summarizer.
function wireTools(deps: TurnDeps): readonly ToolSpec[] {
  const specs = [...deps.tools.values()].map((tool) => tool.spec);
  return deps.subagents === undefined ? specs : [...specs, TASK_SPEC];
}

// The log is JSON, and the log is the source of truth: a fact that cannot survive a
// JSON round trip cannot be recorded faithfully, and "replay equals the live state"
// would break silently. This is reachable, not theoretical — `JSON.parse('-0')`
// really yields -0, and `JSON.stringify(-0)` is "0".
//
// Normalizing here, before the call is either recorded or executed, keeps the log
// equal to what the tool actually ran with. Only values `JSON.stringify` refuses
// outright (BigInt, cyclic structures) cannot be normalized; those fail the turn.
function normalizeCall(call: ToolCall): ToolCall {
  let text: unknown;
  try {
    text = JSON.stringify(call.input);
  } catch {
    throw new Error(`tool call ${call.callId} (${call.name}) has an input that cannot be written to the log`);
  }
  // JSON.stringify(undefined) is undefined rather than a string — but its lib type
  // says `string`, so keep the result as unknown and check it at runtime.
  return { ...call, input: typeof text === 'string' ? (JSON.parse(text) as unknown) : null };
}

// The two facts a rule can narrow on beyond the tool's own name and risk (ADR-027).
// Both are read from the tool's declaration — `ToolSpec.pathInput` /
// `commandInput` — so the kernel needs no knowledge of any particular tool's input
// shape, and a tool that declares neither simply produces neither.
//
// The path goes through FsPort here, at the single place the request is built,
// because ADR-017 makes FsPort the one owner of path identity: a rule compares
// canonical paths, and must never see two spellings of the same file.
//
// A missing or non-string field is "no path", never an empty string: a rule
// selecting on `path` has to fail closed (see matchesWhen), so the field must be
// absent rather than present-and-useless.
function actionFields(fs: FsPort, spec: ToolSpec, input: unknown): Pick<ActionRequest, 'path' | 'command'> {
  if (spec.pathInput === undefined && spec.commandInput === undefined) return {};
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
  const read = (field: string | undefined): string | undefined => {
    if (field === undefined || record === undefined) return undefined;
    const value = record[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const path = read(spec.pathInput);
  const command = read(spec.commandInput);
  // exactOptionalPropertyTypes: `path: undefined` is not assignable to `path?: string`,
  // so a field is only present when there is something to put in it.
  return {
    ...(path === undefined ? {} : { path: fs.canonical(path) }),
    ...(command === undefined ? {} : { command }),
  };
}

// Words for the two ways a question ends badly. They are different on purpose: a
// user who said no and a session that waited too long are not the same fact, and the
// model is told which one happened so it can react differently.
const REJECTED_BY_USER = 'rejected by user';
const REJECTED_BY_TIMEOUT = 'rejected: no answer within the approval timeout';

interface ApprovalOutcome {
  readonly verdict: ApprovalVerdict;
  readonly by: ApprovalBy;
}

// What one call produced: the result the model will see, plus the canonical path the
// log records for the "read before write" gate (ADR-049).
interface CompletedCall {
  readonly result: ToolResult;
  readonly path: string | null;
}

// Refusal text when a write-risk tool is about to overwrite an existing file the
// session has not read, or `null` when the call may proceed.
//
// Creating a file needs no prior read (`exists` is false), and a tool that declares no
// `pathInput` has no target to gate. Everything else is the rule the legacy in-memory
// `readSet` enforced — now reconstructible from the log, so a reopened session still
// has it.
function unreadTarget(deps: TurnDeps, spec: ToolSpec, path: string | null): string | null {
  if (spec.risk !== 'write' || path === null || !deps.fs.exists(path)) return null;
  if (deps.session.state.readFiles.some((known) => deps.fs.samePath(known, path))) return null;
  return `${path} already exists and has not been read in this session; read it before writing over it`;
}

/**
 * Waits for an answer, but not forever (ADR-032), and not past a cancellation.
 *
 * The abort handling is a fix rather than a port: the legacy implementation's
 * approval was a bare `await`, so `signal` was never consulted while a question was
 * open — a cancelled session sat on the question until the human answered it. The
 * listener is removed in `finally`, otherwise every call would leave one behind on a
 * long-lived signal.
 */
async function askForApproval(
  deps: TurnDeps,
  request: ActionRequest,
  decision: Decision,
  signal: AbortSignal,
): Promise<ApprovalOutcome> {
  const limit = deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ApprovalOutcome>((resolve, reject) => {
      const abort = (): void => {
        reject(new TurnAborted('aborted while waiting for approval'));
      };
      timer = setTimeout(() => {
        resolve({ verdict: 'reject', by: 'timeout' });
      }, limit);
      if (signal.aborted) {
        abort();
        return;
      }
      onAbort = abort;
      signal.addEventListener('abort', onAbort, { once: true });
      deps.approve(request, decision).then(
        (verdict) => {
          resolve({ verdict, by: 'user' });
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function runCall(deps: TurnDeps, call: ToolCall, signal: AbortSignal): Promise<CompletedCall> {
  const { session } = deps;
  const turnId = session.turnId;
  const isTask = deps.subagents !== undefined && call.name === TASK_TOOL_NAME;
  // A malformed delegation is refused before policy: there is no action to adjudicate,
  // and asking a person about a call that cannot run is theatre.
  let taskInput: TaskInput | null = null;
  if (isTask) {
    const parsed = parseTaskInput(call.input);
    if (!parsed.ok) return { result: { ok: false, output: `invalid Task input: ${parsed.reason}` }, path: null };
    taskInput = parsed.input;
  }
  const tool = deps.tools.get(call.name);
  // `Task` is not in `deps.tools`: it is the kernel's own tool, present only when a port
  // was supplied (ADR-080 ②/③). Its spec still goes through the same decision path, so
  // delegating is as auditable as running a command.
  const taskSpec = isTask ? TASK_SPEC : null;
  const spec = taskSpec ?? tool?.spec;
  if (spec === undefined) return { result: { ok: false, output: `unknown tool: ${call.name}` }, path: null };

  // Risk is the child's ceiling rather than the tool's own category (ADR-080 ①): `explore`
  // can only read, so the existing `reads-are-free` baseline lets it through without a
  // question; `general` can execute, so it asks until a rule or a person says otherwise.
  const risk: ToolRisk = taskInput === null ? spec.risk : taskInput.role === 'explore' ? 'read' : 'exec';

  // Built once: the request needs it canonicalised, and the log records the same value
  // (ADR-049) — computing it twice is how the two spellings would drift apart.
  const fields = actionFields(deps.fs, spec, call.input);
  const path = fields.path ?? null;
  const request: ActionRequest = {
    kind: 'tool',
    callId: call.callId,
    name: call.name,
    risk,
    input: call.input,
    ...fields,
  };
  const decision = decide(request, deps.rules);
  await session.emit({ type: 'policy.decided', turnId, callId: call.callId, decision });

  if (decision.verdict === 'deny') {
    return { result: { ok: false, output: `denied by ${decision.rule}: ${decision.reason ?? 'no reason given'}` }, path };
  }

  // The "read before write" gate (ADR-049). It lives in the kernel because that is
  // where `readFiles` is: a tool cannot see the session state, and passing the state
  // into a tool would give it a window onto the state machine the layers forbid.
  // Checked before an approval prompt is raised — asking about a write that will be
  // refused is theatre.
  const unread = unreadTarget(deps, spec, path);
  if (unread !== null) return { result: { ok: false, output: unread }, path };

  // Whether THIS call was granted by a person — the only thing `ToolGrant.networkApproved`
  // reports (ADR-051). A `deny` or a `reject` never reaches the tool at all; an `allow`
  // verdict means no question was asked, so nothing was granted either.
  let approved = false;

  if (decision.verdict === 'ask') {
    const key = approvalKey(request);
    const toolKey = toolGrantKey(request.name);
    // Recorded with the question (ADR-095): a warning that only lives in the frontend
    // cannot be replayed, and the log is where "what was the user told?" is answered.
    const warning = assessCommand(request.command)?.message ?? null;
    const standing: ApprovalVerdict | null = session.state.grants.includes(key)
      ? 'always'
      : session.state.grants.includes(toolKey)
        ? 'session'
        : null;
    if (standing !== null) {
      // A standing answer from earlier in this session (ADR-031 decision 3, ADR-094).
      // No question is asked — it was already answered, and asking again is theatre —
      // but the answer IS recorded, with `by: 'policy'`, so the log does not show an
      // `ask` that was somehow ignored. The `key` is the link back to that question.
      await session.emit({
        type: 'approval.answered',
        turnId,
        callId: call.callId,
        key: standing === 'always' ? key : toolKey,
        verdict: standing,
        by: 'policy',
      });
      approved = true;
    } else if (deps.unattended !== undefined) {
      // Nobody can answer here (ADR-081 ③). The question and the refusal are both
      // written: a log that shows only the refusal would look like the kernel made the
      // decision on its own, and a log that shows only the question would look like the
      // turn is still waiting.
      await session.emit({
        type: 'approval.requested',
        turnId,
        callId: call.callId,
        name: call.name,
        rule: decision.rule,
        reason: decision.reason,
        ...(warning === null ? {} : { warning }),
      });
      await session.emit({
        type: 'approval.answered',
        turnId,
        callId: call.callId,
        key,
        verdict: 'reject',
        by: 'unattended',
      });
      return { result: { ok: false, output: `rejected: ${deps.unattended}` }, path };
    } else {
      await session.transition('awaiting_approval', decision.rule);
      // The question is written before it is asked, so a log that ends here says what
      // was being asked instead of leaving a hole.
      await session.emit({
        type: 'approval.requested',
        turnId,
        callId: call.callId,
        name: call.name,
        rule: decision.rule,
        reason: decision.reason,
        ...(warning === null ? {} : { warning }),
      });
      const outcome = await askForApproval(deps, request, decision, signal);
      await session.emit({
        type: 'approval.answered',
        turnId,
        callId: call.callId,
        // A `session` answer grants the tool, so the recorded key has to be the tool-level
        // one: `reduce` rebuilds the grants from the ANSWER, never from the question.
        key: outcome.verdict === 'session' ? toolKey : key,
        verdict: outcome.verdict,
        by: outcome.by,
      });
      await session.transition('awaiting_tools');
      if (outcome.verdict === 'reject') {
        const rejected = outcome.by === 'timeout' ? REJECTED_BY_TIMEOUT : REJECTED_BY_USER;
        return { result: { ok: false, output: rejected }, path };
      }
      approved = true;
    }
  }

  // Delegation is the one "tool" the kernel runs itself (ADR-080 ②). Reaching this point
  // means it was not denied and, when the rules asked, that a person allowed it.
  if (taskSpec !== null) {
    if (taskInput === null) return { result: { ok: false, output: 'invalid Task input' }, path: null };
    return await runSubagentCall(deps, call, taskInput, signal);
  }
  // Unreachable by construction (`spec` came from one of the two), kept so the two
  // branches stay typed without a non-null assertion, which the repository forbids.
  if (tool === undefined) return { result: { ok: false, output: `unknown tool: ${call.name}` }, path: null };

  const grant: ToolGrant = { networkApproved: approved };
  try {
    return { result: await tool.run(call.input, signal, grant), path };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { result: { ok: false, output: message }, path };
  }
}

/**
 * Run one `Task` call (ADR-080/082).
 *
 * Three things happen here that a `ToolPort` could not do: the child's session id is
 * minted before anything can fail (so the parent log names it even when creation dies),
 * the two `subagent.*` facts are written to the parent log, and the returned report is
 * clipped before it enters the parent's context.
 *
 * A failed spawn is a tool result, not a failed turn: the model can decide to do the work
 * itself, and the parent's log still says what was tried.
 */
async function runSubagentCall(
  deps: TurnDeps,
  call: ToolCall,
  task: TaskInput,
  signal: AbortSignal,
): Promise<CompletedCall> {
  const subagents = deps.subagents;
  if (subagents === undefined) return { result: { ok: false, output: `unknown tool: ${call.name}` }, path: null };

  const { description, prompt, role, maxTurns } = task;

  const childSessionId = deps.ids.next('sess');
  const turnId = deps.session.turnId;
  await deps.session.emit({
    type: 'subagent.started',
    turnId,
    callId: call.callId,
    childSessionId,
    role,
    description,
  });

  let outcome: SubagentOutcome;
  try {
    outcome = await subagents.port.spawn(
      {
        parentSessionId: deps.session.state.sessionId,
        sessionId: childSessionId,
        callId: call.callId,
        description,
        prompt,
        role,
        maxTurns,
      },
      signal,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const state = signal.aborted ? 'cancelled' : 'failed';
    await deps.session.emit({
      type: 'subagent.finished',
      turnId,
      callId: call.callId,
      childSessionId,
      role,
      ok: false,
      state,
      turns: 0,
      partial: false,
      usage: null,
      reason,
    });
    // A cancelled parent ends its turn; the child's own end is the port's business.
    if (signal.aborted) throw error;
    return { result: { ok: false, output: `sub agent failed: ${reason}` }, path: null };
  }

  await deps.session.emit({
    type: 'subagent.finished',
    turnId,
    callId: call.callId,
    childSessionId: outcome.sessionId,
    role: outcome.role,
    ok: outcome.state === 'completed',
    state: outcome.state,
    turns: outcome.turns,
    partial: outcome.partial,
    usage: outcome.usage,
    reason: outcome.reason,
  });

  if (signal.aborted) throw new TurnAborted('aborted while a sub agent was running');

  const { text, truncation } = clipReport(outcome.report);
  return {
    result: {
      ok: outcome.state === 'completed',
      output: formatTaskResult(outcome, text),
      ...(truncation === null ? {} : { truncation }),
    },
    path: null,
  };
}
