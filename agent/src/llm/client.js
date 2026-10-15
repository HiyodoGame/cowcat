// Provider abstraction: shared fetch/retry logic + factory.
import { ConfigError, resolveModelConfig } from '../config.js';

export class LLMError extends Error {
  constructor(msg, { status, retryable } = {}) {
    super(msg);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST helper with retry: 429/5xx/network -> exponential backoff (<=3 retries); 401/403 -> config error.
export async function postJSON(url, headers, body, { timeoutMs = 300000, retries = 3, signal = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    if (signal) {
      if (signal.aborted) { lastErr = new DOMException('aborted', 'AbortError'); break; }
      signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new ConfigError(
          `HTTP ${res.status} from ${url}: check COWCAT_API_KEY / credentials (body: ${(await res.text()).slice(0, 300)})`
        );
      }
      if (res.status === 429 || res.status >= 500) {
        const text = (await res.text()).slice(0, 300);
        throw new LLMError(`HTTP ${res.status}: ${text}`, { status: res.status, retryable: true });
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        throw new LLMError(`HTTP ${res.status}: ${text}`, { status: res.status, retryable: false });
      }
      return res;
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable ?? (e.name === 'AbortError' || e.cause?.code === 'ECONNRESET');
      if (!retryable || attempt === retries) throw e;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Parse an SSE body (web ReadableStream) into parsed JSON events.
export async function* parseSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return undefined;
    const raw = dataLines.join('\n');
    dataLines = [];
    if (raw === '[DONE]') return { __done: true };
    try { return JSON.parse(raw); } catch { return null; }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      else if (line === '' || line.startsWith(':')) {
        const ev = flush();
        if (ev !== undefined && ev !== null) yield ev;
      }
    }
  }
  const ev = flush();
  if (ev !== undefined && ev !== null) yield ev;
}

// Protocol registry: model ref → resolved provider entry → protocol module.
// The resolved cfg carries protocol/baseURL/apiKey (see config.js
// resolveModelConfig); providers receive that resolved object.
const PROTOCOL_MODULES = {
  anthropic: './anthropic.js',
  openai: './openai.js',
};

export async function createProvider(cfg) {
  resolveModelConfig(cfg); // idempotent; overlays protocol/baseURL/apiKey/model
  const mod = PROTOCOL_MODULES[cfg.protocol];
  if (!mod) throw new ConfigError(`Unsupported protocol "${cfg.protocol}" (expected anthropic|openai)`);
  if (cfg.protocol === 'openai') {
    const { OpenAIProvider } = await import('./openai.js');
    return new OpenAIProvider(cfg);
  }
  const { AnthropicProvider } = await import('./anthropic.js');
  return new AnthropicProvider(cfg);
}

// Build a ReadableStream from an array of strings (used by tests / mock providers).
export function streamOfStrings(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        await sleep(0);
      }
      controller.close();
    },
  });
}
