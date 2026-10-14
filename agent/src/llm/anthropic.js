// Anthropic Messages API provider (native protocol + SSE normalization).
import { postJSON, parseSSE, LLMError } from './client.js';

const API_VERSION = '2023-06-01';
// Declared capabilities (P2): token counting and interleaved thinking blocks.
// Deliberately NOT claude-code-20250219 / prompt-caching-scope: we do not
// impersonate the claude-cli identity.
const BETA_HEADER = 'token-counting-2024-11-01,interleaved-thinking-2025-05-14';

// Normalize a raw Anthropic message JSON into internal blocks:
// [{type:'text',text}] | [{type:'tool_use',id,name,input}]
export function normalizeAnthropicMessage(msg) {
  const content = (msg.content || []).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
    return null;
  }).filter(Boolean);
  return {
    role: 'assistant',
    content,
    stopReason: msg.stop_reason ?? null,
    usage: msg.usage ?? null,
  };
}

// Aggregate streamed Anthropic events into the same shape as normalizeAnthropicMessage.
export function aggregateAnthropicStream(events, onText) {
  const blocks = new Map(); // index -> block
  const order = [];
  let stopReason = null;
  let usage = null;
  for (const ev of events) {
    switch (ev.type) {
      case 'content_block_start': {
        const cb = ev.content_block;
        const block = cb.type === 'text'
          ? { type: 'text', text: '' }
          : cb.type === 'tool_use'
            ? { type: 'tool_use', id: cb.id, name: cb.name, input: '' }
            : cb.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { type: cb.type };
        blocks.set(ev.index, block);
        order.push(ev.index);
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(ev.index);
        if (!block) break;
        const d = ev.delta;
        if (d.type === 'text_delta') {
          block.text += d.text;
          onText?.(d.text);
        } else if (d.type === 'input_json_delta') {
          block.input += d.partial_json;
        } else if (d.type === 'thinking_delta') {
          block.thinking += d.thinking;
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) usage = { ...(usage || {}), ...ev.usage };
        break;
      case 'message_start':
        if (ev.message?.usage) usage = { ...(usage || {}), ...ev.message.usage };
        break;
      case 'message_stop':
        break;
      default:
        break;
    }
  }
  const content = order.map((i) => {
    const b = blocks.get(i);
    if (b?.type === 'tool_use') {
      let input = {};
      try { input = JSON.parse(b.input || '{}'); } catch { /* leave raw string input */ }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    }
    return b;
  }).filter(Boolean);
  return { role: 'assistant', content, stopReason, usage };
}

export class AnthropicProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.kind = 'anthropic';
  }

  headers() {
    return {
      'x-api-key': this.cfg.apiKey || '',
      'anthropic-version': API_VERSION,
      'authorization': `Bearer ${this.cfg.apiKey || ''}`,
      'anthropic-beta': BETA_HEADER,
      'user-agent': `cowcat/${this.cfg.version || '0.0.0'}`,
    };
  }

  // Session-scoped identity for request metadata. Set once per session by the CLI.
  setSessionId(sessionId) { this.sessionId = sessionId; }

  requestMetadata() {
    if (!this.cfg.installId) return undefined;
    return { user_id: `user_${this.cfg.installId}_account__session_${this.sessionId || 'nosession'}` };
  }

  // POST /v1/messages/count_tokens — used as a precise context probe and as
  // the sizing input for the large-file reminder. Throws on any failure;
  // callers fall back to local estimation.
  async countTokens({ system, messages } = {}) {
    const res = await postJSON(`${this.cfg.baseURL}/v1/messages/count_tokens?beta=true`, this.headers(), {
      model: this.cfg.model,
      system: Array.isArray(system) ? system.map((s) => ({ type: 'text', text: s })) : system,
      messages: toAnthropicMessages(messages || []),
      metadata: this.requestMetadata(),
    }, { timeoutMs: this.cfg.timeoutMs });
    const data = await res.json();
    if (typeof data.input_tokens !== 'number') throw new LLMError(`count_tokens: unexpected payload ${JSON.stringify(data).slice(0, 200)}`);
    return data.input_tokens;
  }

  // request: {system, messages, tools, maxTokens, onText, stream, temperature}
  // returns {role:'assistant', content, stopReason, usage}
  async chat(request) {
    const { system, messages, tools, onText, stream = true } = request;
    const body = buildAnthropicRequestBody(this.cfg, { ...request, stream, metadata: this.requestMetadata() });
    const res = await postJSON(`${this.cfg.baseURL}/v1/messages`, this.headers(), body, {
      timeoutMs: this.cfg.timeoutMs,
      signal: request.signal,
    });
    if (!stream) {
      const msg = await res.json();
      const norm = normalizeAnthropicMessage(msg);
      for (const b of norm.content) if (b.type === 'text') onText?.(b.text);
      return norm;
    }
    const events = [];
    for await (const ev of parseSSE(res)) {
      if (ev.__done) break;
      events.push(ev);
    }
    return aggregateAnthropicStream(events, onText);
  }
}

// Thinking budget for the sub agent `effort` knob (tools/agent.js): low turns
// thinking off; larger efforts get proportionally bigger budgets, clamped
// below max_tokens so the API never rejects the request.
const EFFORT_BUDGETS = { medium: 1024, high: 4096, xhigh: 10_000, max: 16_000 };

export function thinkingForEffort(effort, maxTokens) {
  const budget = EFFORT_BUDGETS[effort];
  if (!budget) return undefined; // low / unknown -> leave thinking off/default
  const cap = maxTokens ? Math.max(1024, maxTokens - 512) : budget;
  return { type: 'enabled', budget_tokens: Math.min(budget, cap) };
}

// Build the /v1/messages request body, placing prompt-cache breakpoints the way
// the reference CLI does (dynamic-findings §3): system tail block, and the tail
// block of the most recent message. Disabled entirely when cfg.cache === false.
export function buildAnthropicRequestBody(cfg, { system, messages, tools, maxTokens, stream = true, temperature, metadata, model, effort }) {
  const cache = cfg.cache !== false;
  const EPHEMERAL = { type: 'ephemeral' };
  const mark = (block) => (cache ? { ...block, cache_control: EPHEMERAL } : block);

  // system: string -> single block; array of strings -> one text block each.
  // Breakpoint sits on the LAST system block (identity + main prompt); short
  // environment-only prefixes stay unmarked so they form a stable cache prefix.
  let systemBlocks;
  if (Array.isArray(system)) {
    systemBlocks = system.map((s, i) => (i === system.length - 1
      ? mark({ type: 'text', text: s })
      : { type: 'text', text: s }));
  } else if (system) {
    systemBlocks = [mark({ type: 'text', text: system })];
  }

  const wireMessages = toAnthropicMessages(messages);
  if (cache && wireMessages.length) {
    const last = wireMessages[wireMessages.length - 1];
    if (typeof last.content === 'string') {
      // plain-text user message: wrap so its tail block can carry the breakpoint
      last.content = [mark({ type: 'text', text: last.content })];
    } else if (Array.isArray(last.content) && last.content.length) {
      last.content[last.content.length - 1] = mark(last.content[last.content.length - 1]);
    }
  }

  const thinking = thinkingForEffort(effort, maxTokens ?? cfg.maxTokens);
  return {
    model: model ?? cfg.model,
    max_tokens: maxTokens ?? cfg.maxTokens,
    system: systemBlocks,
    messages: wireMessages,
    tools: tools?.length ? tools.map(toAnthropicTool) : undefined,
    stream,
    ...(thinking ? { thinking } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

// Convert internal messages to Anthropic wire format.
export function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      // internal tool_result pseudo-role -> user message with tool_result block
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_use_id, content: m.content, is_error: m.is_error }] };
    }
    // thinking blocks are output-only in the Messages API; never echo them back upstream
    const content = Array.isArray(m.content)
      ? m.content.filter((b) => b.type !== 'thinking')
      : m.content;
    return { role: m.role, content };
  });
}

export function toAnthropicTool(tool) {
  return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
}
