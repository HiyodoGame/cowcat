// Event-log → span translation, OTel-free (ADR-132/133). The translator is a pure
// state machine over the live event stream: given a SpanSink it emits exactly the
// span tree the ADR-133 mapping promises. The OTel binding (otel-sink.ts) is a thin
// adapter behind SpanSink, and tests can use a recording sink without any SDK.

import type { KernelEvent, SessionUpdate } from '../../kernel/events.js';

export type SpanKindName = 'internal' | 'client';
export type SpanStatus = 'unset' | 'ok' | 'error';
export type SpanAttributeValue = string | number | boolean | readonly string[];

/**
 * A span as the sink handed it back. Opaque to the translator: whatever the sink
 * needs to parent or end its own representation rides inside the implementation.
 */
export interface StartedSpan {
  /** `errorType` is set as `error.type` only when status is 'error'. */
  end(
    endMs: number,
    status: SpanStatus,
    attributes?: Readonly<Record<string, SpanAttributeValue>>,
    errorType?: string,
  ): void;
  addEvent(name: string, ms: number, attributes?: Readonly<Record<string, SpanAttributeValue>>): void;
  setAttributes(attributes: Readonly<Record<string, SpanAttributeValue>>): void;
}

export interface SpanSink {
  start(input: {
    readonly name: string;
    readonly kind: SpanKindName;
    readonly startMs: number;
    readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
    readonly parent?: StartedSpan;
  }): StartedSpan;
}

export interface TranslatorInput {
  /** `gen_ai.agent.name` (span name suffix). Defaults to 'cowcat'. */
  readonly agentName?: string;
  /** `gen_ai.agent.version`. Omitted when absent. */
  readonly agentVersion?: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
// A round's model call is over once the turn leaves the streaming phase.
const ROUND_END: ReadonlySet<string> = new Set(['awaiting_tools', 'awaiting_approval', 'finishing']);

/**
 * Map the kernel's vendor-neutral StopReason.kind onto protocol finish words
 * (ADR-133 ②). `other` passes through as `other` — inventing a protocol word for
 * a kind we do not know would be the lie ADR-035 exists to prevent.
 */
function finishReasons(kind: 'end' | 'toolCalls' | 'maxTokens' | 'other'): string {
  switch (kind) {
    case 'end':
      return 'stop';
    case 'toolCalls':
      return 'tool_calls';
    case 'maxTokens':
      return 'length';
    case 'other':
      return 'other';
  }
}

/**
 * Build the (sessionId) → translator tap. One translator per host, shared by every
 * adopted session: the conversation id comes from each event's own `sessionId`
 * (ADR-132 ③ — forked sessions emit under their new id and are metered as the new
 * conversation they are).
 *
 * The returned function never throws (ADR-132 ④): a broken sink must not take a
 * session down with it.
 */
export function createSpanTranslator(
  sink: SpanSink,
  input: TranslatorInput = {},
): { readonly observe: (update: SessionUpdate) => void; readonly finish: (abandonMs: number) => void } {
  const agentName = input.agentName ?? 'cowcat';

  // Per-conversation state, keyed by sessionId so interleaved sessions coexist.
  interface Conversation {
    provider: string | null;
    turn: StartedSpan | null;
    chat: StartedSpan | null;
    /** When the turn last entered awaiting_tools — the tool-span start approximation. */
    toolsSinceMs: number | null;
    turnModel: string | null;
  }
  const conversations = new Map<string, Conversation>();

  const conversation = (event: KernelEvent): Conversation => {
    let c = conversations.get(event.sessionId);
    if (c === undefined) {
      c = { provider: null, turn: null, chat: null, toolsSinceMs: null, turnModel: null };
      conversations.set(event.sessionId, c);
    }
    return c;
  };

  const endChat = (c: Conversation, ms: number, status: SpanStatus, errorType?: string): void => {
    if (c.chat !== null) {
      c.chat.end(ms, status, undefined, errorType);
      c.chat = null;
    }
  };

  const observe = (update: SessionUpdate): void => {
    try {
      // SessionUpdate also carries the ephemeral stream fragments (model.delta et al.)
      // that ADR-108 keeps out of the fact log. They have no sessionId and no span
      // meaning — a streamed token is not a fact, the final model.message is.
      if (!('sessionId' in update)) return;
      const event = update;
      const c = conversation(event);
      // The creating preset id (session.opened.model, ADR-126) is the only place the
      // provider name appears on the wire — and the tap may attach AFTER it was
      // emitted (a session is created before it is opened/adopted), so this updates
      // rather than initializes. Old logs without the field simply never set the
      // attribute: semconv says only what is readily available.
      if (event.type === 'session.opened' && event.model !== undefined && event.model.includes('/')) {
        c.provider = event.model.split('/')[0] ?? null;
        // Backfill the spans that started before the provider was known — an
        // attribute that corrects itself beats one that is wrong forever.
        if (c.provider !== null) {
          c.turn?.setAttributes({ 'gen_ai.provider.name': c.provider });
          c.chat?.setAttributes({ 'gen_ai.provider.name': c.provider });
        }
      }
      switch (event.type) {
        case 'turn.opened': {
          // Defensive: a dangling turn implies the previous one died without a
          // terminal transition. Close it as abandoned rather than leaking spans.
          if (c.turn !== null) {
            endChat(c, event.ts, 'error', 'turn_abandoned');
            c.turn.end(event.ts, 'error', undefined, 'turn_abandoned');
            c.turn = null;
          }
          c.turnModel = event.model ?? null;
          const attributes: Record<string, SpanAttributeValue> = {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': agentName,
            'gen_ai.conversation.id': event.sessionId,
          };
          if (c.provider !== null) attributes['gen_ai.provider.name'] = c.provider;
          if (input.agentVersion !== undefined) attributes['gen_ai.agent.version'] = input.agentVersion;
          c.turn = sink.start({
            name: `invoke_agent ${agentName}`,
            kind: 'internal',
            startMs: event.ts,
            attributes,
          });
          break;
        }
        case 'turn.transitioned': {
          if (event.to === 'requesting' && event.from !== 'requesting') {
            // A new round. The previous chat span (if any) was already ended by the
            // leaving transition; not ending it here is what keeps one chat span per
            // round instead of one nesting disaster.
            const attributes: Record<string, SpanAttributeValue> = {
              'gen_ai.operation.name': 'chat',
              'gen_ai.request.stream': true,
              'gen_ai.conversation.id': event.sessionId,
            };
            if (c.provider !== null) attributes['gen_ai.provider.name'] = c.provider;
            if (c.turnModel !== null) {
              attributes['gen_ai.request.model'] = c.turnModel;
              c.chat = sink.start({
                name: `chat ${c.turnModel}`,
                kind: 'client',
                startMs: event.ts,
                attributes,
                ...(c.turn === null ? {} : { parent: c.turn }),
              });
            } else {
              c.chat = sink.start({
                name: 'chat',
                kind: 'client',
                startMs: event.ts,
                attributes,
                ...(c.turn === null ? {} : { parent: c.turn }),
              });
            }
          } else if (ROUND_END.has(event.to)) {
            endChat(c, event.ts, 'unset');
            if (event.to === 'awaiting_tools') c.toolsSinceMs = event.ts;
          } else if (TERMINAL.has(event.to)) {
            endChat(c, event.ts, event.to === 'failed' ? 'error' : 'unset', event.to === 'failed' ? 'turn_failed' : undefined);
            if (c.turn !== null) {
              c.turn.end(
                event.ts,
                event.to === 'failed' ? 'error' : 'unset',
                undefined,
                event.to === 'failed' ? 'turn_failed' : undefined,
              );
              c.turn = null;
            }
            c.toolsSinceMs = null;
          }
          break;
        }
        case 'model.usage': {
          c.chat?.setAttributes({
            'gen_ai.usage.input_tokens': event.usage.input,
            'gen_ai.usage.output_tokens': event.usage.output,
            ...(event.usage.cacheRead > 0 ? { 'gen_ai.usage.cache_read.input_tokens': event.usage.cacheRead } : {}),
            ...(event.usage.cacheCreation > 0 ? { 'gen_ai.usage.cache_write.input_tokens': event.usage.cacheCreation } : {}),
          });
          break;
        }
        case 'model.message': {
          if (event.stopReason !== null) {
            c.chat?.setAttributes({ 'gen_ai.response.finish_reasons': [finishReasons(event.stopReason.kind)] });
          }
          break;
        }
        case 'tool.finished': {
          const attributes: Record<string, SpanAttributeValue> = {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': event.name,
            'gen_ai.tool.call.id': event.callId,
            'gen_ai.conversation.id': event.sessionId,
          };
          if (c.provider !== null) attributes['gen_ai.provider.name'] = c.provider;
          const span = sink.start({
            name: `execute_tool ${event.name}`,
            kind: 'internal',
            // ADR-133 ③: no tool.started event exists; the span starts when the turn
            // entered awaiting_tools (the earliest honest approximation), never
            // before the tool actually began.
            startMs: c.toolsSinceMs ?? event.ts,
            attributes,
            ...(c.turn === null ? {} : { parent: c.turn }),
          });
          span.end(event.ts, event.ok ? 'unset' : 'error', undefined, event.ok ? undefined : 'tool_error');
          break;
        }
        case 'approval.requested': {
          c.turn?.addEvent(
            'cowcat.approval.requested',
            event.ts,
            {
              'cowcat.approval.rule': event.rule,
              ...(event.dimensions === undefined ? {} : { 'cowcat.approval.dimensions': event.dimensions }),
            },
          );
          break;
        }
        case 'approval.answered': {
          c.turn?.addEvent(
            'cowcat.approval.answered',
            event.ts,
            {
              'cowcat.approval.verdict': event.verdict,
              'cowcat.approval.by': event.by,
            },
          );
          break;
        }
        default:
          break;
      }
    } catch {
      // ADR-132 ④: telemetry is a view, never a dependency. A broken sink loses
      // spans, not the session.
    }
  };

  const finish = (abandonMs: number): void => {
    for (const c of conversations.values()) {
      try {
        endChat(c, abandonMs, 'error', 'host_shutdown');
        if (c.turn !== null) {
          c.turn.end(abandonMs, 'error', undefined, 'host_shutdown');
          c.turn = null;
        }
      } catch {
        // Same contract as observe: never throw.
      }
    }
  };

  return { observe, finish };
}
