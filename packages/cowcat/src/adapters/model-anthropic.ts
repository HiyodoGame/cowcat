import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message } from '../kernel/messages.js';
import type { ModelChunk, ModelPort, ModelRequest, ModelUsage, StopReason, ToolSpec } from '../ports/index.js';
import { NO_RETRY, asHeaderReader, retryAfterMs, retryableStatus, withRetry, type RetryDecision, type RetryPolicy } from './model-retry.js';

// The Anthropic adapter (ADR-036). Needed for Claude itself and for the four MiniMax
// entries in the provider catalogue — the only catalogued providers whose protocol is
// Anthropic rather than OpenAI-compatible.
//
// Same two omissions as the OpenAI adapter, for the same reasons: retries live in
// `withRetry` under ADR-039's policy rather than in the SDK, and the end of the iterator —
// not `stop_reason` — is what ends the stream.

export interface AnthropicModelOptions {
  readonly apiKey: string;
  /** Absent means the SDK's own default (api.anthropic.com). */
  readonly baseURL?: string;
  /** Injected so a test can replay recorded bytes and CI cannot reach the network (ADR-042). */
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides for ADR-039's defaults. */
  readonly retry?: RetryPolicy;
}

export function anthropicModel(options: AnthropicModelOptions): ModelPort {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    maxRetries: 0,
  });

  return {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
      if (request.maxTokens === undefined) {
        // This protocol has no default: `max_tokens` is a required field, and picking a
        // number here would be the adapter inventing a policy that belongs to a model
        // preset (ADR-037).
        throw new Error(
          `the Anthropic protocol requires max_tokens, and the request for ${request.model} did not carry one`,
        );
      }
      // Hoisted because the closure below is where the compiler stops tracking the check
      // above, and `max_tokens` is not optional in the wire type.
      const maxTokens = request.maxTokens;

      // Only the response is retried; the iteration below runs outside the retry, which
      // is how "a stream that has already produced output is never retried" holds by
      // construction (ADR-039 decision ③).
      const stream = await withRetry({
        signal,
        attempt: (attemptSignal) =>
          client.messages.create(
            {
              model: request.model,
              max_tokens: maxTokens,
              messages: toWireMessages(request.messages),
              stream: true,
              ...(request.system === undefined ? {} : { system: request.system }),
              ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toWireTool) }),
            },
            { signal: attemptSignal },
          ),
        classify: (error, attemptSignal) => classifyAnthropic(error, signal, attemptSignal),
        ...(options.retry === undefined ? {} : { policy: options.retry }),
      });

      // Tool use arrives in pieces like OpenAI's, but indexed by content block instead
      // of by `tool_calls[].index`: `content_block_start` carries id and name, and
      // `input_json_delta` carries `partial_json` fragments. `input` is a *string* here
      // and has to be parsed once the block stops.
      const blocks = new Map<number, { id: string; name: string; json: string }>();
      let usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      let finished: string | null = null;

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            // The only place input and cache counts appear.
            usage = startUsage(event.message.usage);
            yield { type: 'usage', usage };
            break;
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const block = blocks.get(event.index);
              if (block !== undefined) block.json += event.delta.partial_json;
            }
            // `thinking_delta` and others are deliberately not mapped yet: the contract
            // has no place for reasoning content, and inventing one here would decide a
            // question that belongs with the preset work (T6).
            break;
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (block !== undefined) {
              blocks.delete(event.index);
              yield {
                type: 'tool_call',
                call: { callId: block.id, name: block.name, input: parseInput(block) },
              };
            }
            break;
          }
          case 'message_delta':
            if (event.delta.stop_reason !== null) finished = event.delta.stop_reason;
            // Cumulative, and it omits the optional keys — so it is merged into what
            // `message_start` already gave rather than replacing it. A replace would
            // silently drop the input and cache counts (ADR-040).
            usage = mergeUsage(usage, event.usage.output_tokens);
            yield { type: 'usage', usage };
            break;
          case 'message_stop':
            break;
        }
      }

      if (finished !== null) yield { type: 'stop', reason: mapStopReason(finished) };
    },
  };
}

// The internal history is flat; the wire format is not. Two things have to happen here:
// an assistant turn becomes content blocks, and **consecutive tool results are merged
// into the single user turn that must carry them** — this protocol pairs results with
// their calls through that one message, and a `role: 'tool'` per result is an OpenAI
// shape it does not have.
function toWireMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  const wire: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const previous = wire[wire.length - 1];
      const result: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: message.callId,
        content: message.output,
        ...(message.ok ? {} : { is_error: true }),
      };
      if (previous?.role === 'user' && Array.isArray(previous.content) && isAllToolResults(previous.content)) {
        previous.content.push(result);
      } else {
        wire.push({ role: 'user', content: [result] });
      }
      continue;
    }
    if (message.role === 'user') {
      wire.push({ role: 'user', content: [{ type: 'text', text: message.text }] });
      continue;
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (message.text !== '') blocks.push({ type: 'text', text: message.text });
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.callId, name: call.name, input: call.input ?? {} });
    }
    // An assistant turn with neither text nor calls cannot be represented, and cannot
    // occur: `model.message` always carries at least one of them.
    if (blocks.length > 0) wire.push({ role: 'assistant', content: blocks });
  }
  return wire;
}

function isAllToolResults(content: Anthropic.ContentBlockParam[]): boolean {
  return content.length > 0 && content.every((block) => block.type === 'tool_result');
}

function toWireTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    // Unwrapped, unlike OpenAI's `{ type: 'function', function: { parameters } }`, and
    // the same `inputSchema` the other adapter reads (see ports/index.ts).
    input_schema: (spec.inputSchema ?? { type: 'object', properties: {} }) as Anthropic.Tool['input_schema'],
  };
}

function parseInput(block: { id: string; name: string; json: string }): unknown {
  if (block.json === '') return {};
  try {
    return JSON.parse(block.json) as unknown;
  } catch {
    // Same choice as the OpenAI adapter: a turn that cannot be decoded is reported
    // rather than repaired, so the log never disagrees with what the model sent.
    throw new Error(
      `tool call ${block.id} (${block.name}) carried input that is not JSON: ${block.json.slice(0, 200)}`,
    );
  }
}

function startUsage(usage: Anthropic.Usage): ModelUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
  };
}

function mergeUsage(current: ModelUsage, outputTokens: number): ModelUsage {
  return { ...current, output: outputTokens };
}

function mapStopReason(raw: string): StopReason {
  if (raw === 'end_turn' || raw === 'stop_sequence') return { kind: 'end', raw };
  if (raw === 'tool_use') return { kind: 'toolCalls', raw };
  if (raw === 'max_tokens') return { kind: 'maxTokens', raw };
  return { kind: 'other', raw };
}

// Same shape as the OpenAI adapter's classifier, and for the same reason: which failures
// deserve another attempt is protocol knowledge (ADR-039). Anthropic's `overloaded_error`
// arrives as 529, which `retryableStatus` covers as a 5xx.
function classifyAnthropic(error: unknown, callerSignal: AbortSignal, attemptSignal: AbortSignal): RetryDecision {
  if (callerSignal.aborted) return NO_RETRY;
  if (error instanceof APIUserAbortError) return NO_RETRY;
  if (attemptSignal.aborted) return { retry: true, afterMs: null };
  if (error instanceof APIConnectionError) return { retry: true, afterMs: null };
  if (error instanceof APIError) {
    const status: unknown = error.status;
    if (typeof status !== 'number' || !retryableStatus(status)) return NO_RETRY;
    return { retry: true, afterMs: retryAfterMs(asHeaderReader(error.headers)) };
  }
  return NO_RETRY;
}
