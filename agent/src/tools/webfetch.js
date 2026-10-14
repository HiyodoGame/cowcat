// WebFetch: fetch a URL and return readable content. HTML is converted to a
// lightweight markdown-ish text (scripts/styles stripped, headings/lists/links
// preserved); plain text passes through; binary content is rejected. Output is
// capped at 20k chars. No domain allowlist yet (P1 adds permission rules).

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT = 20_000;

function htmlToText(html) {
  let s = html;
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ');
  // block-level structure -> markdown-ish lines
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${stripTags(inner)}\n\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre)>/gi, '\n\n');
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = stripTags(inner).trim();
    return text ? `[${text}](${href})` : '';
  });
  s = stripTags(s);
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export const WebFetchTool = {
  name: 'WebFetch',
  description: `Fetch a URL over HTTP and return its content as readable text for the model.
HTML pages are converted to a lightweight markdown-like form (scripts, styles and markup removed; headings, lists, links and paragraphs preserved). Plain text is returned as-is. PDFs and other binary content are rejected — fetch those another way.
Use this to read documentation, release notes, issue pages, or any web reference the task needs. Prefer it over curl-ing pages through Bash: it handles timeouts, size limits and HTML noise for you. Large pages are truncated; if the slice you need is missing, narrow the prompt or fetch a more specific URL.`,
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      prompt: { type: 'string', description: 'Optional guidance: what information to extract from the page' },
    },
    required: ['url'],
  },
  async execute(input, ctx) {
    const fetchImpl = ctx.fetch ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(input.url, { signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: `Fetch failed: ${e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : e.message}` };
    }
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} fetching ${input.url}` };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); } catch (e) {
      return { ok: false, error: `Failed to read response body: ${e.message}` };
    }
    if (buf.length > MAX_BYTES) return { ok: false, error: `Response too large (${buf.length} bytes, limit ${MAX_BYTES})` };
    if (buf.includes(0) && !type.includes('html')) {
      return { ok: false, error: `Binary content (${type || 'unknown type'}) cannot be read as text` };
    }
    let text;
    if (type.includes('html') || /<html[\s>]/i.test(buf.slice(0, 512).toString('utf8'))) {
      text = htmlToText(buf.toString('utf8'));
    } else if (!type || type.includes('text') || type.includes('json') || type.includes('xml') || type.includes('javascript')) {
      text = buf.toString('utf8');
    } else {
      return { ok: false, error: `Unsupported content type "${type}" — only HTML and text can be read` };
    }
    let output = text;
    if (input.prompt) output = `${input.prompt}\n\n--- page content ---\n${text}`;
    const truncated = output.length > MAX_OUTPUT;
    return {
      ok: true,
      output: output.slice(0, MAX_OUTPUT) + (truncated ? `\n[truncated at ${MAX_OUTPUT} chars]` : ''),
    };
  },
};
