// OpenAI-compatible chat/completions provider, normalized to the internal message format.
import { postJSON, parseSSE } from './client.js';
import { estimateTokensLocal } from './tokapprox.js';

// Reasoning field names across OpenAI-compatible endpoints: DeepSeek/GLM/Kimi
// stream `reasoning_content`; OpenAI o-series uses `reasoning`. Either may be a
// string or an array of typed parts (rare); we take the string form.
function reasoningOf(msgOrDelta) {
  const r = msgOrDelta?.reasoning_content ?? msgOrDelta?.reasoning;
  return typeof r === 'string' ? r : '';
}

// Normalize a non-streaming OpenAI chat completion into internal assistant shape.
export function normalizeOpenAIMessage(data) {
  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};
  const content = [];
  const reasoning = reasoningOf(msg);
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep raw */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return {
    role: 'assistant',
    content,
    stopReason: choice?.finish_reason ?? null,
    usage: data.usage ?? null,
  };
}

// Aggregate streamed OpenAI chunk deltas into the same internal shape.
// onToolDelta (optional 4th arg, backwards-compatible with positional callers):
// fired per chunk carrying tool_calls deltas as { index, id?, name?, argsDelta }
// and once per tool after the event loop as { index, id, name, argsComplete, done }.
// The buffered aggregate return value is identical either way.
export function aggregateOpenAIStream(events, onText, onThinking, onToolDelta) {
  let text = '';
  let thinking = '';
  const toolCalls = new Map(); // index -> {id, name, args}
  const order = [];
  let stopReason = null;
  let usage = null;
  for (const ev of events) {
    if (ev.__done) break;
    const choice = ev.choices?.[0];
    if (!choice) { if (ev.usage) usage = ev.usage; continue; }
    if (choice.finish_reason) stopReason = choice.finish_reason;
    const d = choice.delta || {};
    const reasoning = reasoningOf(d);
    if (reasoning) { thinking += reasoning; onThinking?.(reasoning); }
    if (d.content) { text += d.content; onText?.(d.content); }
    for (const tc of d.tool_calls || []) {
      if (!toolCalls.has(tc.index)) {
        toolCalls.set(tc.index, { id: tc.id || '', name: '', args: '' });
        order.push(tc.index);
      }
      const agg = toolCalls.get(tc.index);
      if (tc.id) agg.id = tc.id;
      if (tc.function?.name) agg.name = tc.function.name;
      if (tc.function?.arguments) agg.args += tc.function.arguments;
      onToolDelta?.({ index: tc.index, id: tc.id || undefined, name: tc.function?.name || undefined, argsDelta: tc.function?.arguments || '' });
    }
    if (ev.usage) usage = ev.usage;
  }
  // Completion signal fires after the loop (not on finish_reason): providers
  // vary on whether a usage-only chunk or [DONE] follows the finish chunk,
  // and tool deltas may still arrive after finish_reason on some endpoints.
  for (const i of order) {
    const t = toolCalls.get(i);
    onToolDelta?.({ index: i, id: t.id || undefined, name: t.name || undefined, argsComplete: t.args, done: true });
  }
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  for (const i of order) {
    const t = toolCalls.get(i);
    let input = {};
    try { input = JSON.parse(t.args || '{}'); } catch { input = { __raw: t.args }; }
    content.push({ type: 'tool_use', id: t.id || `call_${i}`, name: t.name, input });
  }
  return { role: 'assistant', content, stopReason, usage };
}

// Sub agent `effort` -> OpenAI reasoning_effort: the wire only knows
// low/medium/high, so the two extended tiers collapse onto high.
const REASONING_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

export class OpenAIProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.kind = 'openai';
  }

  headers() {
    return { authorization: `Bearer ${this.cfg.apiKey || ''}` };
  }

  // No official counting endpoint: use the local calibrated estimator over
  // the serialized request (system + messages). Purely local — no network.
  async countTokens({ system, messages } = {}) {
    let chars = 0;
    if (system) chars += (Array.isArray(system) ? system.join('\n\n') : system).length;
    for (const m of messages || []) chars += JSON.stringify(m).length;
    return estimateTokensLocal(' '.repeat(chars));
  }

  async chat(request) {
    const { system, messages, tools, onText, stream = true } = request;
    const body = {
      model: request.model ?? this.cfg.model,
      max_tokens: request.maxTokens ?? this.cfg.maxTokens,
      messages: toOpenAIMessages(system, messages),
      tools: tools?.length ? tools.map(toOpenAITool) : undefined,
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
      ...(request.effort ? { reasoning_effort: REASONING_EFFORT[request.effort] } : {}),
    };
    const base = this.cfg.baseURL.replace(/\/+$/, '');
    const res = await postJSON(`${base}/chat/completions`, this.headers(), body, {
      timeoutMs: this.cfg.timeoutMs,
      signal: request.signal,
    });
    if (!stream) {
      const data = await res.json();
      const norm = normalizeOpenAIMessage(data);
      for (const b of norm.content) if (b.type === 'text') onText?.(b.text);
      return norm;
    }
    const events = [];
    for await (const ev of parseSSE(res)) events.push(ev);
    return aggregateOpenAIStream(events, onText, request.onThinking, request.onToolDelta);
  }
}

// Internal -> OpenAI wire format.
export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) {
    const text = Array.isArray(system) ? system.join('\n\n') : system;
    out.push({ role: 'system', content: text });
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      // internal tool_result pseudo-role
      out.push({ role: 'tool', tool_call_id: m.tool_use_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      continue;
    }
    const texts = [];
    const toolResults = [];
    const toolUses = [];
    for (const b of m.content || []) {
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'tool_use') toolUses.push(b);
      else if (b.type === 'tool_result') toolResults.push(b);
      else if (b.type === 'thinking') { /* local-only: never echo reasoning back upstream */ }
    }
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: texts.join('') || null,
        ...(toolUses.length ? {
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
          })),
        } : {}),
      });
    } else {
      // tool responses must immediately follow the assistant tool_calls message,
      // so emit them before any text (e.g. reminder blocks) from the same turn
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        });
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('') });
    }
  }
  return out;
}

export function toOpenAITool(tool) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  };
}
