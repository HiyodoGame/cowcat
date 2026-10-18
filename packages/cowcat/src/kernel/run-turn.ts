import { approvalKey, type ApprovalBy, type ApprovalVerdict } from '../policy/approval.js';
import { decide, type ActionRequest, type Decision, type Rule } from '../policy/decide.js';
import type { FsPort, IdSource, ModelPort, ModelRequest, StopReason, ToolGrant, ToolPort, ToolResult, ToolSpec } from '../ports/index.js';
import type { ReasoningBlock, ToolCall } from './messages.js';
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
}

/**
 * A static fact the run worked under, not something the run observed (ADR-046
 * decisions ③/④): a model the preset says cannot take tools, or a reasoning level the
 * preset never described. The log has no place for these — an event records what
 * happened, and configuration is not an event — so they ride the outcome instead.
 */
export type TurnNote =
  | { readonly kind: 'tools-unsupported'; readonly model: string }
  | { readonly kind: 'effort-not-declared'; readonly model: string; readonly effort: string };

export interface TurnOutcome {
  readonly state: TerminalTurnState;
  readonly reason: string | null;
  /** Empty in the common case; see TurnNote. */
  readonly notes: readonly TurnNote[];
}

class TurnAborted extends Error {}

export async function runTurn(deps: TurnDeps, input: string, signal: AbortSignal): Promise<TurnOutcome> {
  const { session } = deps;
  const effort = wireEffort(deps.preset, deps.effort);
  // Computed once, before anything can fail: they describe the configuration the run
  // works under, so every exit carries them (ADR-046).
  const notes: TurnNote[] = [];
  if (!deps.preset.toolCalls) notes.push({ kind: 'tools-unsupported', model: deps.preset.model });
  if (effort.note !== null) notes.push(effort.note);

  await session.openTurn(input);
  try {
    for (;;) {
      if (signal.aborted) throw new TurnAborted('aborted before the model was called');
      const calls = await streamModel(deps, effort.providerOptions, signal);
      if (calls.length === 0) {
        await session.transition('finishing');
        await session.transition('completed');
        return { state: 'completed', reason: null, notes };
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
    return { state: outcome, reason, notes };
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

async function streamModel(
  deps: TurnDeps,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal,
): Promise<readonly ToolCall[]> {
  const { session, model, preset, tools } = deps;
  const turnId = session.turnId;
  if (turnId === null) throw new Error('streamModel outside a turn');

  const request: ModelRequest = {
    messages: session.state.messages,
    // The preset's `toolCalls` gates the one place tools are put on the wire; a model
    // that cannot take them runs the same turn without (ADR-046 decision ③).
    tools: preset.toolCalls ? [...tools.values()].map((tool) => tool.spec) : [],
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
  const tool = deps.tools.get(call.name);
  if (tool === undefined) return { result: { ok: false, output: `unknown tool: ${call.name}` }, path: null };

  // Built once: the request needs it canonicalised, and the log records the same value
  // (ADR-049) — computing it twice is how the two spellings would drift apart.
  const fields = actionFields(deps.fs, tool.spec, call.input);
  const path = fields.path ?? null;
  const request: ActionRequest = {
    kind: 'tool',
    callId: call.callId,
    name: call.name,
    risk: tool.spec.risk,
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
  const unread = unreadTarget(deps, tool.spec, path);
  if (unread !== null) return { result: { ok: false, output: unread }, path };

  // Whether THIS call was granted by a person — the only thing `ToolGrant.networkApproved`
  // reports (ADR-051). A `deny` or a `reject` never reaches the tool at all; an `allow`
  // verdict means no question was asked, so nothing was granted either.
  let approved = false;

  if (decision.verdict === 'ask') {
    const key = approvalKey(request);
    if (session.state.grants.includes(key)) {
      // A standing `always` from earlier in this session (ADR-031 decision 3). No
      // question is asked — it was already answered, and asking again is theatre —
      // but the answer IS recorded, with `by: 'policy'`, so the log does not show an
      // `ask` that was somehow ignored. The `key` is the link back to that question.
      await session.emit({
        type: 'approval.answered',
        turnId,
        callId: call.callId,
        key,
        verdict: 'always',
        by: 'policy',
      });
      approved = true;
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
      });
      const outcome = await askForApproval(deps, request, decision, signal);
      await session.emit({
        type: 'approval.answered',
        turnId,
        callId: call.callId,
        key,
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

  const grant: ToolGrant = { networkApproved: approved };
  try {
    return { result: await tool.run(call.input, signal, grant), path };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { result: { ok: false, output: message }, path };
  }
}
