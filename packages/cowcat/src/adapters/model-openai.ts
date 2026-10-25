import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { Message, ReasoningBlock } from '../kernel/messages.js';
import type { Attachment, ModelChunk, ModelPort, ModelRequest, ModelUsage, StopReason, ToolSpec } from '../ports/index.js';
import { tryMaterializeAttachment, unavailableAttachmentNote } from './attachments.js';
import { NO_RETRY, asHeaderReader, retryAfterMs, retryableStatus, withRetry, type RetryDecision, type RetryPolicy } from './model-retry.js';
import { contextOverflow } from './model-overflow.js';

// The OpenAI-compatible adapter (ADR-036): one protocol that 201 of the 209 catalogued
// providers speak, Chat Completions rather than the Responses API, because a compatible
// endpoint implements Chat Completions and nothing else.
//
// Two things this file deliberately does NOT do:
//
// - It does not let the SDK retry: the SDK would do it behind ADR-039's policy (which
//   also covers `Retry-After`, per-attempt deadlines and never retrying a stream that has
//   already produced output), so its own retries are switched off and T5's live in
//   `withRetry`.
// - It does not decide when the stream ended from `finish_reason`. Providers disagree
//   about what follows a finishing chunk — some send a usage-only chunk, some send
//   `[DONE]`, some keep going with tool-call deltas (`agent/src/llm/openai.js:69-71`).
//   The end of the iterator is the end.
//
// Reasoning (ADR-045) is read from the two vendor spellings in `reasoningDeltaOf` and
// written back only when the preset names a field for it (see `splitProviderOptions`):
// whether an endpoint wants the reasoning back in the request is not in the catalogue
// and not measured here, so the preset's data decides, never a default (ADR-038/046).

export interface OpenAIModelOptions {
  readonly apiKey: string;
  /** A compatible endpoint. Absent means the SDK's own default (api.openai.com). */
  readonly baseURL?: string;
  /**
   * Where the bytes come from. Injected so a test can replay a recorded stream and so
   * "CI never reaches the network" is a property of the wiring rather than a promise
   * (ADR-042).
   */
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides for ADR-039's defaults. */
  readonly retry?: RetryPolicy;
}

export function openAIModel(options: OpenAIModelOptions): ModelPort {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    maxRetries: 0,
  });

  return {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
      const { wire, reasoningReplayField } = splitProviderOptions(request.providerOptions);

      // Only the response is retried. Everything below this line runs outside the retry,
      // which is how "a stream that has already produced output is never retried" holds
      // by construction (ADR-039 decision ③).
      const stream = await withRetry({
        signal,
        attempt: (attemptSignal) =>
          client.chat.completions.create(
            {
              model: request.model,
              messages: toWireMessages(request, reasoningReplayField),
              stream: true,
              // Without this the stream carries no usage at all, and the usage that does
              // arrive comes on a chunk whose `choices` is empty (ADR-040).
              stream_options: { include_usage: true },
              ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
              ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toWireTool) }),
              // What the preset declared goes last; the reserved-field check above is
              // what keeps a declared parameter from colliding with the fields this
              // adapter just built.
              ...wire,
            },
            { signal: attemptSignal },
          ),
        classify: (error, attemptSignal) => classifyOpenAI(error, signal, attemptSignal),
        ...(options.retry === undefined ? {} : { policy: options.retry }),
      }).catch((error: unknown) => {
        const overflow = contextOverflow(error, error instanceof APIError ? error.status : null);
        if (overflow !== null) throw overflow;
        throw error;
      });

      // Tool calls arrive as fragments keyed by `index`: the first fragment carries the
      // id and name, and `arguments` is a JSON *string* assembled across fragments.
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let finished: string | null = null;

      // Reasoning arrives as deltas, but the contract records whole blocks (ADR-045): a
      // block is flushed the moment the run of reasoning ends — on the first chunk that
      // carries text or tool calls, or at the end of the stream — because a recorded
      // fragment is not a fact the kernel could replay.
      let reasoning = '';
      let reasoningOpen = false;

      for await (const chunk of stream) {
        // `choices` is empty on a usage-only chunk, so it has to be read before it is
        // indexed — that chunk is the normal way usage arrives, not an edge case.
        const [choice] = chunk.choices;
        if (choice !== undefined) {
          const { delta } = choice;
          const reasoningDelta = reasoningDeltaOf(delta);
          if (reasoningDelta !== '') {
            reasoning += reasoningDelta;
            reasoningOpen = true;
            // Live display; the recorded block is still flushed at the end of the run.
            yield { type: 'reasoning.delta', text: reasoningDelta };
          }
          const text = typeof delta.content === 'string' ? delta.content : '';
          if (reasoningOpen && (text !== '' || (delta.tool_calls ?? []).length > 0)) {
            yield reasoningChunk(reasoning);
            reasoning = '';
            reasoningOpen = false;
          }
          if (text !== '') {
            yield { type: 'text', text };
          }
          for (const fragment of delta.tool_calls ?? []) {
            const call = pending.get(fragment.index) ?? { id: '', name: '', args: '' };
            if (fragment.id !== undefined) call.id = fragment.id;
            if (fragment.function?.name !== undefined) call.name = fragment.function.name;
            if (fragment.function?.arguments !== undefined) call.args += fragment.function.arguments;
            pending.set(fragment.index, call);
          }
          if (choice.finish_reason !== null) {
            finished = choice.finish_reason;
          }
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          yield { type: 'usage', usage: fromWireUsage(chunk.usage) };
        }
      }

      // A stream that reasoned and then simply stopped still has its block to report.
      if (reasoningOpen) yield reasoningChunk(reasoning);

      // Assembled calls are emitted once they are complete: a `ModelChunk` carries a
      // whole call, because the kernel normalises and records one as a single fact.
      // Index order, so the same bytes always produce the same sequence.
      for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: 'tool_call', call: { callId: call.id, name: call.name, input: parseArguments(call) } };
      }
      if (finished !== null) yield { type: 'stop', reason: mapStopReason(finished) };
    },
  };
}

// The preset's one non-wire key (ADR-038, ADR-046): it names the field the model's own
// reasoning is replayed under (`'reasoning_content'` for the endpoints that ask for it).
// Whether a vendor wants reasoning back is not in the catalogue and not measured here —
// so absence means "do not send reasoning back", and that is the default for every
// endpoint.
const REASONING_REPLAY = 'reasoning_replay';

// What this adapter constructs itself; a preset that names one of these is refused
// rather than silently overwritten (ADR-044, ADR-046).
const RESERVED_BODY_FIELDS = ['model', 'messages', 'stream', 'stream_options', 'tools', 'max_tokens'] as const;

// Where `reasoning_replay` may not point: the request-level fields above, plus the ones
// this adapter writes into a message. Replay *adds* a field, so a name that collides
// would silently corrupt the message it rides on (`role`, `content`, `tool_calls`) — a
// malformed request built out of a preset typo is exactly what "refuse, do not send"
// exists for (ADR-044).
const REPLAY_FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  ...RESERVED_BODY_FIELDS,
  'role',
  'content',
  'tool_calls',
]);

/**
 * Splits the preset's escape hatch into what the wire should carry and how reasoning
 * should be sent back: every key is relayed as declared (ADR-046) except
 * `reasoning_replay`, which this adapter consumes instead of sending.
 */
function splitProviderOptions(options: Readonly<Record<string, unknown>> | undefined): {
  readonly wire: Readonly<Record<string, unknown>>;
  readonly reasoningReplayField: string | null;
} {
  if (options === undefined) return { wire: {}, reasoningReplayField: null };
  for (const field of RESERVED_BODY_FIELDS) {
    if (field in options) {
      throw new Error(
        `providerOptions may not set "${field}": the adapter builds that field from the request (ADR-046)`,
      );
    }
  }
  const { [REASONING_REPLAY]: replay, ...wire } = options;
  if (replay === undefined) return { wire, reasoningReplayField: null };
  if (typeof replay !== 'string' || replay === '') {
    throw new Error(
      `providerOptions.${REASONING_REPLAY} must name a non-empty wire field, got ${JSON.stringify(replay)}`,
    );
  }
  if (REPLAY_FORBIDDEN_FIELDS.has(replay)) {
    throw new Error(
      `providerOptions.${REASONING_REPLAY} may not name "${replay}": the adapter builds that field`,
    );
  }
  return { wire, reasoningReplayField: replay };
}

// The internal history is flat (messages.ts) and the wire format is not: a tool result
// is its own message paired by id, and an assistant turn carries its calls inline. The
// mapping lives here because it is protocol knowledge, and it is the whole reason the
// internal shape can stay flat.
function toWireMessages(
  request: ModelRequest,
  reasoningReplayField: string | null,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const wire: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (request.system !== undefined) wire.push({ role: 'system', content: request.system });
  for (const message of request.messages) wire.push(...toWireMessagesFor(message, reasoningReplayField));
  // The direct-call channel (ADR-139): images join the FIRST user message as content
  // parts, after its text. Unlike the conversation path (ADR-069), a missing file here
  // is still named-not-dropped: the note rides the same message.
  if (request.images !== undefined && request.images.length > 0) {
    const parts = directImageParts(request.images);
    const firstUser = wire.find((message) => message.role === 'user');
    if (firstUser !== undefined) {
      // Narrowed to the user variant by the find predicate; content is string or parts.
      const user = firstUser as { content: string | OpenAI.Chat.ChatCompletionContentPart[] | undefined };
      user.content =
        typeof user.content === 'string' ? [{ type: 'text', text: user.content }, ...parts] : [...(user.content ?? []), ...parts];
    } else {
      wire.push({ role: 'user', content: parts });
    }
  }
  return wire;
}

/** Materialize direct-call images into content parts (ADR-139). */
function directImageParts(images: readonly Attachment[]): OpenAI.Chat.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
  for (const image of images) {
    if (image.type === 'document') {
      // Named, not dropped (ADR-016): this protocol has no portable document part,
      // same call the tool-result path makes.
      parts.push({ type: 'text', text: `document referenced, not inlined: ${image.mediaType} at ${image.path} (${String(image.bytes)} bytes)` });
      continue;
    }
    const materialized = tryMaterializeAttachment(image);
    if (!materialized.ok) {
      parts.push({ type: 'text', text: unavailableAttachmentNote(image, materialized.error.reason) });
      continue;
    }
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${materialized.value.mediaType};base64,${materialized.value.base64}` },
    });
  }
  return parts;
}

/**
 * One internal message becomes one wire message — except a tool result with
 * attachments, which becomes two.
 *
 * That is Chat Completions' shape, not our choice: a `role: 'tool'` message's content is
 * a string, and images are content parts of a *user* message. So the attachment goes out
 * as the next user turn, right after the result it belongs to (ADR-057's "two adapters
 * each map it their own way" — Anthropic needs no such thing).
 */
function toWireMessagesFor(
  message: Message,
  reasoningReplayField: string | null,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.text }];
    case 'assistant': {
      const toolCalls = message.toolCalls.map((call) => ({
        id: call.callId,
        type: 'function' as const,
        // `input` survived a JSON round trip before it was recorded (run-turn.ts), so
        // stringifying it cannot fail here.
        function: { name: call.name, arguments: JSON.stringify(call.input ?? null) },
      }));
      // The reasoning goes back only when the preset named a field for it (ADR-045/046):
      // whether an endpoint wants it back is not something this adapter can know, so
      // absence — the default — means "do not send reasoning back". The text of the
      // blocks is rejoined because this protocol's field is one string; a block the way
      // Anthropic means it does not exist here.
      const replay: Record<string, string> = {};
      if (reasoningReplayField !== null) {
        const reasoningText = reasoningTextOf(message);
        if (reasoningText !== '') replay[reasoningReplayField] = reasoningText;
      }
      return [
        {
          role: 'assistant',
          // `null`, not an empty string: a turn that only called tools has no text, and
          // sending `''` alongside `tool_calls` is a shape some endpoints reject.
          content: message.text === '' ? null : message.text,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          ...replay,
        },
      ];
    }
    case 'tool': {
      // The name is deliberately absent: the wire format pairs a result with its call
      // by `tool_call_id`, and the call is the only place the name belongs.
      const result: OpenAI.Chat.ChatCompletionMessageParam = {
        role: 'tool',
        tool_call_id: message.callId,
        content: message.output,
      };
      if (message.attachments.length === 0) return [result];
      return [result, attachmentMessage(message.attachments)];
    }
  }
}

/**
 * The images of a tool result, as the user turn that this protocol needs them to be.
 *
 * Documents are named rather than inlined: Chat Completions has no portable document
 * part, and inventing one would be this adapter guessing at a vendor's beta surface. The
 * note says so **in the request**, so the model is not left believing it saw the file —
 * a silent omission would be the same failure as a silently dropped image (ADR-016).
 */
function attachmentMessage(attachments: readonly Attachment[]): OpenAI.Chat.ChatCompletionMessageParam {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
  const documents: string[] = [];
  const missing: string[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'document') {
      documents.push(`${attachment.mediaType} at ${attachment.path} (${String(attachment.bytes)} bytes)`);
      continue;
    }
    const materialized = tryMaterializeAttachment(attachment);
    if (!materialized.ok) {
      // An image whose file is gone is named, not dropped, and not fatal (ADR-069): the
      // reference stays in the history, so failing here would fail every later turn too.
      missing.push(unavailableAttachmentNote(attachment, materialized.error.reason));
      continue;
    }
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${materialized.value.mediaType};base64,${materialized.value.base64}` },
    });
  }
  const head =
    documents.length === 0
      ? 'Attachments from the previous tool result:'
      : `Attachments from the previous tool result (documents are referenced, not inlined — this protocol has no portable document part):\n${documents.join('\n')}`;
  const text = missing.length === 0 ? head : `${head}\n${missing.join('\n')}`;
  return { role: 'user', content: [{ type: 'text', text }, ...parts] };
}

// The two vendor spellings for streamed reasoning, neither of which the SDK's chunk type
// carries because both are extensions: DeepSeek/GLM/Kimi say `reasoning_content`, the
// o-series says `reasoning` (the same pair v1 read — agent/src/llm/openai.js:6-12). An
// unrecognised spelling simply reads as no reasoning at all.
function reasoningDeltaOf(delta: unknown): string {
  const wire = delta as { readonly reasoning_content?: unknown; readonly reasoning?: unknown };
  if (typeof wire.reasoning_content === 'string') return wire.reasoning_content;
  if (typeof wire.reasoning === 'string') return wire.reasoning;
  return '';
}

// This protocol has no signature concept, so a block arrives with an empty one — which
// is exactly what the contract's `signature: ''` means (ADR-045).
function reasoningChunk(text: string): ModelChunk {
  return { type: 'reasoning', block: { type: 'thinking', text, signature: '' } };
}

function reasoningTextOf(message: { readonly reasoning: readonly ReasoningBlock[] }): string {
  return message.reasoning.flatMap((block) => (block.type === 'thinking' ? [block.text] : [])).join('');
}

function toWireTool(spec: ToolSpec): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      // The wire format cannot say "takes no parameters", and a tool declared without a
      // schema is one a model cannot call correctly. P5 is what fills this in (see the
      // `inputSchema` comment in ports/index.ts).
      parameters: (spec.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    },
  };
}

function parseArguments(call: { id: string; name: string; args: string }): unknown {
  // An empty `arguments` is how some endpoints report a call with no parameters.
  if (call.args === '') return {};
  try {
    return JSON.parse(call.args) as unknown;
  } catch {
    // A turn that cannot be decoded is reported, not repaired: keeping the raw string
    // (which is what v1 did) would push a malformed call into a tool as if it were an
    // argument, and the log would then disagree with what the model actually sent.
    throw new Error(
      `tool call ${call.id} (${call.name}) carried arguments that are not JSON: ${call.args.slice(0, 200)}`,
    );
  }
}

function mapStopReason(raw: string): StopReason {
  // Three kinds the kernel can act on get names; everything else keeps its vendor value
  // under `other` rather than being flattened away (ADR-035).
  if (raw === 'stop') return { kind: 'end', raw };
  if (raw === 'tool_calls') return { kind: 'toolCalls', raw };
  if (raw === 'length') return { kind: 'maxTokens', raw };
  return { kind: 'other', raw };
}

function fromWireUsage(usage: OpenAI.CompletionUsage): ModelUsage {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    cacheRead: cacheReadTokens(usage),
    // This protocol has no cache *write* concept at all. That is a different statement
    // from "the vendor did not report it", and only the adapter can tell them apart
    // (ADR-040).
    cacheCreation: 0,
  };
}

function cacheReadTokens(usage: OpenAI.CompletionUsage): number {
  const standard = usage.prompt_tokens_details?.cached_tokens;
  if (typeof standard === 'number') return standard;
  // DeepSeek-compatible endpoints report the same count under their own name, which the
  // typed field above does not cover — v1 read exactly that field for the same reason
  // (agent/src/loop.js:424).
  const vendorSpecific = (usage as { prompt_cache_hit_tokens?: unknown }).prompt_cache_hit_tokens;
  return typeof vendorSpecific === 'number' ? vendorSpecific : 0;
}

// Which failures are worth another attempt is protocol knowledge, so it lives with the
// protocol (ADR-039). The attempt's own signal is what separates "this attempt ran out of
// time" — worth another go — from "a person cancelled", which never is; both arrive here
// as abort-shaped errors.
function classifyOpenAI(error: unknown, callerSignal: AbortSignal, attemptSignal: AbortSignal): RetryDecision {
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
