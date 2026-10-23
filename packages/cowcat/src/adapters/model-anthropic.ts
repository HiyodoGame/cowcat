import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { Message } from '../kernel/messages.js';
import type { Attachment, ModelChunk, ModelPort, ModelRequest, ModelUsage, StopReason, ToolSpec } from '../ports/index.js';
import { tryMaterializeAttachment, unavailableAttachmentNote } from './attachments.js';
import { NO_RETRY, asHeaderReader, retryAfterMs, retryableStatus, withRetry, type RetryDecision, type RetryPolicy } from './model-retry.js';

// The Anthropic adapter (ADR-036). Needed for Claude itself and for the four MiniMax
// entries in the provider catalogue — the only catalogued providers whose protocol is
// Anthropic rather than OpenAI-compatible.
//
// Same two omissions as the OpenAI adapter, for the same reasons: retries live in
// `withRetry` under ADR-039's policy rather than in the SDK, and the end of the iterator —
// not `stop_reason` — is what ends the stream.
//
// Reasoning (ADR-045) is read from thinking blocks — text from `thinking_delta`, the
// opaque signature from `signature_delta` (which arrives just before the block stops),
// redacted payloads as they came — and sent back only when the preset enables thinking,
// because that is exactly when this protocol requires the blocks: unmodified, in order,
// signatures intact, or the request is a 400.

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
      const { wire, carryReasoning } = splitProviderOptions(request.providerOptions, maxTokens);

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
              messages: toWireMessages(request.messages, request.images, carryReasoning),
              stream: true,
              ...(request.system === undefined ? {} : { system: request.system }),
              ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toWireTool) }),
              // What the preset declared goes last; the reserved-field check above is
              // what keeps it from colliding with the fields this adapter just built.
              ...wire,
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
      const blocks = new Map<number, PendingBlock>();
      let usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      let finished: string | null = null;

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            // The only place input and cache counts appear.
            usage = startUsage(event.message.usage);
            yield { type: 'usage', usage };
            break;
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              blocks.set(event.index, { kind: 'tool', id: block.id, name: block.name, json: '' });
            } else if (block.type === 'thinking') {
              // The text and the signature arrive as deltas; whatever this event already
              // carries is kept, so the block stays faithful if a stream starts
              // delivering content here.
              blocks.set(event.index, { kind: 'thinking', text: block.thinking, signature: block.signature });
            } else if (block.type === 'redacted_thinking') {
              // Whole the moment it starts: a redacted block has no deltas.
              blocks.set(event.index, { kind: 'redacted', data: block.data });
            }
            break;
          }
          case 'content_block_delta': {
            const block = blocks.get(event.index);
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta' && block?.kind === 'tool') {
              block.json += event.delta.partial_json;
            } else if (event.delta.type === 'thinking_delta' && block?.kind === 'thinking') {
              block.text += event.delta.thinking;
              // Display-only; the recorded fact is still the whole block at stop.
              yield { type: 'reasoning.delta', text: event.delta.thinking };
            } else if (event.delta.type === 'signature_delta' && block?.kind === 'thinking') {
              // The signature arrives just before the block stops (messages.d.ts:3787-3794).
              // Appended rather than assigned: the contract records the signature whole,
              // and this is the one place it is assembled.
              block.signature += event.delta.signature;
            }
            break;
          }
          case 'content_block_stop': {
            // A block becomes one chunk — and one recorded fact — when it stops, the
            // same way `tool_call` does: a fragment is not replayable, a whole block is
            // (ADR-045).
            const block = blocks.get(event.index);
            if (block !== undefined) {
              blocks.delete(event.index);
              if (block.kind === 'tool') {
                yield {
                  type: 'tool_call',
                  call: { callId: block.id, name: block.name, input: parseInput(block) },
                };
              } else if (block.kind === 'thinking') {
                yield { type: 'reasoning', block: { type: 'thinking', text: block.text, signature: block.signature } };
              } else {
                yield { type: 'reasoning', block: { type: 'redacted', data: block.data } };
              }
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

// What this adapter constructs itself; a preset that names one of these is refused
// rather than silently overwritten (ADR-044, ADR-046).
const RESERVED_BODY_FIELDS = ['model', 'messages', 'stream', 'tools', 'max_tokens', 'system'] as const;

/**
 * The preset's escape hatch (ADR-046): every key is relayed as declared, and the mere
 * presence of `thinking` is also what turns reasoning replay on — this protocol requires
 * the thinking blocks back precisely when a request enables thinking (ADR-045).
 */
function splitProviderOptions(
  options: Readonly<Record<string, unknown>> | undefined,
  maxTokens: number,
): { readonly wire: Readonly<Record<string, unknown>>; readonly carryReasoning: boolean } {
  if (options === undefined) return { wire: {}, carryReasoning: false };
  for (const field of RESERVED_BODY_FIELDS) {
    if (field in options) {
      throw new Error(
        `providerOptions may not set "${field}": the adapter builds that field from the request (ADR-046)`,
      );
    }
  }
  const thinking = options['thinking'];
  if (thinking === undefined) return { wire: options, carryReasoning: false };
  assertThinkingWithinLimits(thinking, maxTokens);
  // `disabled` is the one declaration that says the model will not think this turn, so
  // there is nothing to carry back — replaying a block while telling the endpoint not to
  // produce one is a combination no recording covers. Every other value (`enabled`,
  // `adaptive`, anything a future SDK adds) may produce thinking blocks, and this
  // protocol requires them back unmodified; that is the side of the line where guessing
  // costs a broken chain rather than an unnecessary field.
  const carryReasoning = (thinking as { type?: unknown }).type !== 'disabled';
  return { wire: options, carryReasoning };
}

/**
 * The one invariant this adapter knows about the escape hatch, and it is a documented
 * fact rather than adapter policy: `budget_tokens` "Must be ≥1024 and less than
 * `max_tokens`" (the SDK's own type documentation, messages.d.ts:3958-3970). A preset
 * that gets this wrong would be a 400 from the endpoint; failing here names the culprit
 * instead (ADR-044).
 */
function assertThinkingWithinLimits(thinking: unknown, maxTokens: number): void {
  if (typeof thinking !== 'object' || thinking === null || Array.isArray(thinking)) {
    throw new Error(`providerOptions.thinking must be an object, got ${JSON.stringify(thinking)}`);
  }
  const { type, budget_tokens: budget } = thinking as { type?: unknown; budget_tokens?: unknown };
  // `adaptive` and `disabled` carry no budget; only `enabled` has the documented bound.
  if (type !== 'enabled') return;
  if (budget === undefined) {
    throw new Error('thinking.budget_tokens is required when thinking.type is "enabled"');
  }
  if (typeof budget !== 'number' || !Number.isInteger(budget)) {
    throw new Error(`thinking.budget_tokens must be an integer, got ${JSON.stringify(budget)}`);
  }
  if (budget < 1024 || budget >= maxTokens) {
    throw new Error(
      `thinking.budget_tokens must be >= 1024 and < max_tokens (${String(maxTokens)}), got ${String(budget)}`,
    );
  }
}

// A content block being assembled. Tool use arrives as `input_json_delta` fragments;
// thinking arrives as `thinking_delta` text plus a `signature_delta` signature; a
// redacted block is whole the moment it starts.
type PendingBlock =
  | { kind: 'tool'; id: string; name: string; json: string }
  | { kind: 'thinking'; text: string; signature: string }
  | { kind: 'redacted'; data: string };

// The internal history is flat; the wire format is not. Two things have to happen here:
// an assistant turn becomes content blocks, and **consecutive tool results are merged
// into the single user turn that must carry them** — this protocol pairs results with
// their calls through that one message, and a `role: 'tool'` per result is an OpenAI
// shape it does not have.
function toWireMessages(messages: readonly Message[], images: readonly Attachment[] | undefined, carryReasoning: boolean): Anthropic.MessageParam[] {
  const wire: Anthropic.MessageParam[] = [];
  // The direct-call channel (ADR-139): images join the FIRST user message after its
  // text, using the same block builder as tool-result attachments.
  const directImages =
    images === undefined || images.length === 0 ? [] : images.filter((image) => image.type === 'image').map(toAttachmentBlock);
  let imagesPlaced = directImages.length === 0;
  for (const message of messages) {
    if (message.role === 'tool') {
      const previous = wire[wire.length - 1];
      const result: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: message.callId,
        // Anthropic is the protocol where an attachment needs no workaround: a tool
        // result's content is a block array, so the image rides in the same message as
        // the text it belongs to (ADR-057).
        content:
          message.attachments.length === 0
            ? message.output
            : [{ type: 'text', text: message.output }, ...message.attachments.map(toAttachmentBlock)],
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
      wire.push({
        role: 'user',
        content:
          imagesPlaced || directImages.length === 0
            ? [{ type: 'text', text: message.text }]
            : [{ type: 'text', text: message.text }, ...directImages],
      });
      imagesPlaced = true;
      continue;
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (carryReasoning) {
      // Thinking blocks go back first — the contract deliberately does not store their
      // position, and the protocol fact replay leans on is that they precede text and
      // tool use — unmodified and in their original order, because anything else is a
      // 400 `invalid_request_error` (ADR-045). Whether they go back at all was the
      // preset's call (`carryReasoning`, ADR-046).
      for (const block of message.reasoning) {
        blocks.push(
          block.type === 'thinking'
            ? { type: 'thinking', thinking: block.text, signature: block.signature }
            : { type: 'redacted_thinking', data: block.data },
        );
      }
    }
    if (message.text !== '') blocks.push({ type: 'text', text: message.text });
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.callId, name: call.name, input: call.input ?? {} });
    }
    // An assistant turn with neither text nor calls cannot be represented, and cannot
    // occur: `model.message` always carries at least one of them.
    if (blocks.length > 0) wire.push({ role: 'assistant', content: blocks });
  }
  // Images with no user message anywhere: they still go out, in their own user turn.
  if (!imagesPlaced && directImages.length > 0) {
    wire.push({ role: 'user', content: [...directImages] });
  }
  return wire;
}

function isAllToolResults(content: Anthropic.ContentBlockParam[]): boolean {
  return content.length > 0 && content.every((block) => block.type === 'tool_result');
}

/**
 * An attachment as this protocol's block. The media type is the producer's claim (the
 * tool read it off the file) and is cast to the vendor's literal union here, because a
 * vendor vocabulary is protocol knowledge and the kernel deliberately does not carry it
 * (ADR-035, and ADR-056's precedent for the same kind of cast).
 *
 * When the bytes are gone the block is a sentence instead (ADR-069): this protocol can
 * carry text in a tool result, so the request still goes out and the model is told what
 * it is not seeing.
 */
function toAttachmentBlock(
  attachment: Attachment,
): Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam | Anthropic.TextBlockParam {
  const materialized = tryMaterializeAttachment(attachment);
  if (!materialized.ok) {
    return { type: 'text', text: unavailableAttachmentNote(attachment, materialized.error.reason) };
  }
  const bytes = materialized.value;
  if (bytes.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: bytes.mediaType as Anthropic.Base64ImageSource['media_type'],
        data: bytes.base64,
      },
    };
  }
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: bytes.mediaType as Anthropic.Base64PDFSource['media_type'],
      data: bytes.base64,
    },
  };
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
