import { approvalKey, type ApprovalBy, type ApprovalVerdict } from '../policy/approval.js';
import { decide, type ActionRequest, type Decision, type Rule } from '../policy/decide.js';
import type { FsPort, IdSource, ModelPort, StopReason, ToolPort, ToolResult, ToolSpec } from '../ports/index.js';
import type { ToolCall } from './messages.js';
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
   * The model this turn asks for (ADR-035). The kernel holds it because which model to
   * call is a decision the session made — an adapter that had to guess would be
   * guessing about someone else's configuration.
   */
  readonly modelId: string;
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

export interface TurnOutcome {
  readonly state: TerminalTurnState;
  readonly reason: string | null;
}

class TurnAborted extends Error {}

export async function runTurn(deps: TurnDeps, input: string, signal: AbortSignal): Promise<TurnOutcome> {
  const { session } = deps;
  await session.openTurn(input);
  try {
    for (;;) {
      if (signal.aborted) throw new TurnAborted('aborted before the model was called');
      const calls = await streamModel(deps, signal);
      if (calls.length === 0) {
        await session.transition('finishing');
        await session.transition('completed');
        return { state: 'completed', reason: null };
      }
      await session.transition('awaiting_tools');
      for (const call of calls) {
        const result = await runCall(deps, call, signal);
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
    return { state: outcome, reason };
  }
}

async function streamModel(deps: TurnDeps, signal: AbortSignal): Promise<readonly ToolCall[]> {
  const { session, model, tools } = deps;
  const turnId = session.turnId;
  if (turnId === null) throw new Error('streamModel outside a turn');

  const request = {
    messages: session.state.messages,
    tools: [...tools.values()].map((tool) => tool.spec),
    model: deps.modelId,
  };
  await session.transition('streaming');

  let text = '';
  let stopReason: StopReason | null = null;
  const calls: ToolCall[] = [];
  for await (const chunk of model.stream(request, signal)) {
    switch (chunk.type) {
      case 'text':
        text += chunk.text;
        session.streamDelta(chunk.text);
        break;
      case 'tool_call':
        calls.push(normalizeCall(chunk.call));
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

  await session.emit({ type: 'model.message', turnId, text, toolCalls: calls, stopReason });
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

async function runCall(deps: TurnDeps, call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
  const { session } = deps;
  const turnId = session.turnId;
  const tool = deps.tools.get(call.name);
  if (tool === undefined) return { ok: false, output: `unknown tool: ${call.name}` };

  const request: ActionRequest = {
    kind: 'tool',
    callId: call.callId,
    name: call.name,
    risk: tool.spec.risk,
    input: call.input,
    ...actionFields(deps.fs, tool.spec, call.input),
  };
  const decision = decide(request, deps.rules);
  await session.emit({ type: 'policy.decided', turnId, callId: call.callId, decision });

  if (decision.verdict === 'deny') {
    return { ok: false, output: `denied by ${decision.rule}: ${decision.reason ?? 'no reason given'}` };
  }

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
        return { ok: false, output: outcome.by === 'timeout' ? REJECTED_BY_TIMEOUT : REJECTED_BY_USER };
      }
    }
  }

  try {
    return await tool.run(call.input, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
