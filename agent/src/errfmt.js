// Provider/API error formatting (P3): turn raw provider failures — LLMError
// with an HTTP status, JSON error bodies like
//   {"error":{"code":"1211","message":"Unknown Model: ..."}}
// fetch/network failures, and plain strings — into a readable summary plus an
// actionable hint. Pure functions; the UIs decide how to paint/expand them.
import { looksLikeVisionUnsupported } from './vision.js';

export const ERR_HINTS = {
  unknownModel: {
    zh: '当前 provider 不支持该模型，请 /model 切换',
    en: 'Model not supported by this provider — switch with /model',
  },
  auth: {
    zh: '认证失败：检查 API key（COWCAT_API_KEY）是否正确',
    en: 'Authentication failed: check your API key (COWCAT_API_KEY)',
  },
  rateLimit: {
    zh: '触发限流，稍后重试',
    en: 'Rate limited — retry in a moment',
  },
  server: {
    zh: '服务端错误（5xx），稍后重试',
    en: 'Server error (5xx) — retry later',
  },
  network: {
    zh: '网络不通：检查 base URL / 代理设置',
    en: 'Network unreachable: check the base URL / proxy',
  },
  visionUnsupported: {
    zh: '该模型可能不接受图片输入：用 /model 换视觉模型，或设 COWCAT_VISION=off 让 Read 提前拒绝并给出提示',
    en: 'This model may not accept image input — switch to a vision-capable model with /model, or set COWCAT_VISION=off so Read refuses early',
  },
};

const NETWORK_RE = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i;
const UNKNOWN_MODEL_RE = /unknown model|model not found|invalid model|not support(ed)? (this )?model/i;

// Extract the first JSON object embedded in a free-text message (providers and
// fetch wrappers embed the response body verbatim, sometimes with trailing
// junk): try the longest brace-balanced prefix that parses.
function jsonBodyOf(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const sliced = text.slice(start);
  let end = sliced.length;
  while (end > 1) {
    const candidate = sliced.slice(0, end);
    try { return JSON.parse(candidate); } catch { /* shrink to the previous } */ }
    const prev = candidate.lastIndexOf('}');
    if (prev <= 0) return null;
    end = prev + 1; // keep the brace, drop whatever trailed it
  }
  return null;
}

// Normalize any thrown value into { status, code, message, hint, raw }.
// `hint` is a key into ERR_HINTS, or null when nothing actionable is known.
export function parseApiError(raw) {
  const err = raw instanceof Error ? raw : new Error(String(raw ?? 'unknown error'));
  const text = String(err.message ?? err);
  const status = Number.isFinite(err.status) ? err.status
    : (() => { const m = /HTTP\s+(\d{3})/.exec(text); return m ? Number(m[1]) : null; })();
  const body = jsonBodyOf(text);
  const e = body && typeof body === 'object' ? (body.error ?? body) : {};
  const code = err.code ?? (e && (e.code ?? e.type)) ?? null;
  let message = (e && (e.message ?? e.msg)) ?? text;
  message = String(message).split('\n')[0].trim();

  let hint = null;
  if (code === '1211' || UNKNOWN_MODEL_RE.test(`${code ?? ''} ${message}`)) hint = 'unknownModel';
  else if (looksLikeVisionUnsupported(`${code ?? ''} ${message}`)) hint = 'visionUnsupported';
  else if (status === 401 || status === 403) hint = 'auth';
  else if (status === 429) hint = 'rateLimit';
  else if (status !== null && status >= 500) hint = 'server';
  else if (status === null && (NETWORK_RE.test(text) || /Error:\s*(fetch|network)/i.test(text))) hint = 'network';

  const summary = [status ? `HTTP ${status}` : null, code ? `[${code}]` : null, message]
    .filter(Boolean).join(' ').slice(0, 300);
  return { status, code: code ? String(code) : null, message, hint, summary, raw: text };
}

// Display lines for a parsed error: a red one-liner + an actionable hint when
// one is known. `raw` keeps the full original detail for expand/ctrl+o cards.
export function formatApiErrorLines(raw, { lang = 'zh' } = {}) {
  const p = raw && raw.summary ? raw : parseApiError(raw);
  const lines = [`✗ ${p.summary}`];
  if (p.hint && ERR_HINTS[p.hint]) lines.push(`  → ${ERR_HINTS[p.hint][lang] ?? ERR_HINTS[p.hint].en}`);
  return { ...p, lines };
}
