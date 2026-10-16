import { decide, type ActionRequest, type Decision, type Rule } from '../policy/decide.js';
import type { IdSource, ModelPort, ToolPort, ToolResult } from '../ports/index.js';
import type { ToolCall } from './messages.js';
import type { Session } from './session.js';
import { isTerminal, type TerminalTurnState } from './turn.js';

export interface TurnDeps {
  readonly session: Session;
  readonly model: ModelPort;
  readonly tools: ReadonlyMap<string, ToolPort>;
  readonly rules: readonly Rule[];
  readonly approve: (request: ActionRequest, decision: Decision) => Promise<boolean>;
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
          ok: result.ok,
          output: result.output,
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
  };
  await session.transition('streaming');

  let text = '';
  const calls: ToolCall[] = [];
  for await (const chunk of model.stream(request, signal)) {
    if (chunk.type === 'text') {
      text += chunk.text;
      session.streamDelta(chunk.text);
    } else {
      calls.push(chunk.call);
    }
  }
  if (signal.aborted) throw new TurnAborted('aborted while streaming');

  await session.emit({ type: 'model.message', turnId, text, toolCalls: calls });
  return calls;
}

async function runCall(deps: TurnDeps, call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
  const { session } = deps;
  const turnId = session.turnId;
  const tool = deps.tools.get(call.name);
  if (tool === undefined) return { ok: false, output: `unknown tool: ${call.name}` };

  const request: ActionRequest = { kind: 'tool', callId: call.callId, name: call.name, risk: tool.spec.risk };
  const decision = decide(request, deps.rules);
  await session.emit({ type: 'policy.decided', turnId, callId: call.callId, decision });

  if (decision.verdict === 'deny') {
    return { ok: false, output: `denied by ${decision.rule}: ${decision.reason ?? 'no reason given'}` };
  }
  if (decision.verdict === 'ask') {
    await session.transition('awaiting_approval', decision.rule);
    const approved = await deps.approve(request, decision);
    await session.transition('awaiting_tools');
    if (!approved) return { ok: false, output: 'rejected by user' };
  }

  try {
    return await tool.run(call.input, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
