// Scripted mock provider: plays back assistant responses, records requests.
// A step is either:
//   { respond: (req) => assistantResult }            — custom logic
//   { message: {...normalized assistant msg} }       — returned as-is
//   { sseAnthropic: [event objects] }                — piped through the real anthropic parser
//   { sseOpenAI: [chunk objects] }                   — piped through the real openai parser
import { aggregateAnthropicStream } from '../src/llm/anthropic.js';
import { aggregateOpenAIStream } from '../src/llm/openai.js';

export function sseEvent(obj) {
  return `event: ${obj.type || 'message'}\ndata: ${JSON.stringify(obj)}\n\n`;
}

export function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Validate that every assistant tool_use id is answered by a tool_result in a
// later message (same pairing rule Anthropic/Kimi enforce on the wire).
export function validateToolPairing(messages) {
  const pending = new Map(); // id -> tool name
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!pending.has(m.tool_use_id)) {
        throw new Error(`tool_result without preceding tool_use: ${m.tool_use_id}`);
      }
      pending.delete(m.tool_use_id);
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        if (pending.has(b.id)) throw new Error(`duplicate tool_use id: ${b.id}`);
        pending.set(b.id, b.name);
      } else if (b.type === 'tool_result') {
        if (!pending.has(b.tool_use_id)) {
          throw new Error(`tool_result without preceding tool_use: ${b.tool_use_id}`);
        }
        pending.delete(b.tool_use_id);
      }
    }
  }
  if (pending.size) {
    const missing = [...pending.entries()].map(([id, name]) => `${name}:${id}`).join(', ');
    throw new Error(`assistant tool_use not followed by tool_result for: ${missing}`);
  }
}

export class MockProvider {
  constructor(script, { kind = 'mock', countTokens = null } = {}) {
    this.script = [...script];
    this.kind = kind;
    this.requests = [];
    this.callCount = 0;
    this.countTokensValue = countTokens; // number | 'error' | (req) => number
    this.countTokensCalls = [];
  }

  async countTokens(request) {
    this.countTokensCalls.push(request);
    const v = this.countTokensValue;
    if (v === 'error') throw new Error('count_tokens unsupported');
    if (typeof v === 'function') return v(request);
    if (typeof v === 'number') return v;
    throw new Error('count_tokens unsupported');
  }

  async chat(request) {
    if (request.messages) validateToolPairing(request.messages);
    this.requests.push(request);
    this.callCount++;
    if (this.script.length === 0) {
      throw new Error(`MockProvider: script exhausted (request #${this.callCount})`);
    }
    const step = this.script.shift();
    const onText = request.onText;

    if (step.sseAnthropic) {
      const result = aggregateAnthropicStream(step.sseAnthropic, onText);
      return result;
    }
    if (step.sseOpenAI) {
      const result = aggregateOpenAIStream(step.sseOpenAI, onText);
      return result;
    }
    if (step.message) {
      for (const b of step.message.content || []) {
        if (b.type === 'text') onText?.(b.text);
      }
      return {
        role: 'assistant',
        content: step.message.content,
        stopReason: step.message.stopReason ?? (step.message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    }
    if (typeof step.respond === 'function') {
      const r = await step.respond(request);
      for (const b of r.content || []) if (b.type === 'text') onText?.(b.text);
      return { stopReason: 'end_turn', usage: null, ...r };
    }
    throw new Error('MockProvider: invalid script step');
  }
}

// Helpers to build common script steps.
export const text = (t) => ({ message: { content: [{ type: 'text', text: t }], stopReason: 'end_turn' } });

export const toolUse = (id, name, input) => ({
  message: { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' },
});
