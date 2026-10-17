import OpenAI from 'openai';
import type { Message } from '../kernel/messages.js';
import type { ModelChunk, ModelPort, ModelRequest, ModelUsage, StopReason, ToolSpec } from '../ports/index.js';

// The OpenAI-compatible adapter (ADR-036): one protocol that 201 of the 209 catalogued
// providers speak, Chat Completions rather than the Responses API, because a compatible
// endpoint implements Chat Completions and nothing else.
//
// Two things this file deliberately does NOT do:
//
// - It does not retry. The SDK would (twice, by default), and ADR-039 gives the retry
//   policy a shape the SDK's own does not have (honour `Retry-After`, never retry a
//   stream that has already produced output). Two retry policies in one path is one
//   policy too many, so the SDK's is switched off here and T5 builds the real one.
// - It does not decide when the stream ended from `finish_reason`. Providers disagree
//   about what follows a finishing chunk — some send a usage-only chunk, some send
//   `[DONE]`, some keep going with tool-call deltas (`agent/src/llm/openai.js:69-71`).
//   The end of the iterator is the end.

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
      const stream = await client.chat.completions.create(
        {
          model: request.model,
          messages: toWireMessages(request),
          stream: true,
          // Without this the stream carries no usage at all, and the usage that does
          // arrive comes on a chunk whose `choices` is empty (ADR-040).
          stream_options: { include_usage: true },
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toWireTool) }),
        },
        { signal },
      );

      // Tool calls arrive as fragments keyed by `index`: the first fragment carries the
      // id and name, and `arguments` is a JSON *string* assembled across fragments.
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let finished: string | null = null;

      for await (const chunk of stream) {
        // `choices` is empty on a usage-only chunk, so it has to be read before it is
        // indexed — that chunk is the normal way usage arrives, not an edge case.
        const [choice] = chunk.choices;
        if (choice !== undefined) {
          const { delta } = choice;
          if (typeof delta.content === 'string' && delta.content !== '') {
            yield { type: 'text', text: delta.content };
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

// The internal history is flat (messages.ts) and the wire format is not: a tool result
// is its own message paired by id, and an assistant turn carries its calls inline. The
// mapping lives here because it is protocol knowledge, and it is the whole reason the
// internal shape can stay flat.
function toWireMessages(request: ModelRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const wire: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (request.system !== undefined) wire.push({ role: 'system', content: request.system });
  for (const message of request.messages) wire.push(toWireMessage(message));
  return wire;
}

function toWireMessage(message: Message): OpenAI.Chat.ChatCompletionMessageParam {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.text };
    case 'assistant': {
      const toolCalls = message.toolCalls.map((call) => ({
        id: call.callId,
        type: 'function' as const,
        // `input` survived a JSON round trip before it was recorded (run-turn.ts), so
        // stringifying it cannot fail here.
        function: { name: call.name, arguments: JSON.stringify(call.input ?? null) },
      }));
      return {
        role: 'assistant',
        // `null`, not an empty string: a turn that only called tools has no text, and
        // sending `''` alongside `tool_calls` is a shape some endpoints reject.
        content: message.text === '' ? null : message.text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      };
    }
    case 'tool':
      // The name is deliberately absent: the wire format pairs a result with its call
      // by `tool_call_id`, and the call is the only place the name belongs.
      return { role: 'tool', tool_call_id: message.callId, content: message.output };
  }
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
