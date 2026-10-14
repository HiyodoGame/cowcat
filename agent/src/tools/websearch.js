// WebSearch: search the web via the DuckDuckGo HTML endpoint (free, no key).
// The engine is injectable (ctx.searchEngine / module-level default) so a
// paid provider can be swapped in later without touching the tool.

const TIMEOUT_MS = 10_000;
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

// --- DuckDuckGo HTML scraping (default engine) ------------------------------

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

export function parseDuckDuckGoResults(html) {
  const results = [];
  // result blocks: <a class="result__a" href="...">title</a> ... <a class="result__snippet"...>snippet</a>
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<(?:a|div)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 50) {
    let url = decodeEntities(m[1]);
    // DDG wraps links: /l/?...uddg=<urlencoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep raw */ } }
    const strip = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    results.push({ title: strip(m[2]), url, snippet: strip(m[3] || m[4] || ''), published_date: null });
  }
  return results;
}

export async function duckDuckGoSearch(query, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(query)}`,
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? `search timed out after ${TIMEOUT_MS / 1000}s` : `search request failed: ${e.message}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`search endpoint returned HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDuckDuckGoResults(html);
  if (!results.length) throw new Error('no results parsed — the search endpoint layout may have changed');
  return results;
}

// --- tool --------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function domainMatch(host, domain) {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return host === d || host.endsWith(`.${d}`);
}

export const WebSearchTool = {
  name: 'WebSearch',
  description: `Search the web and return a list of results (title, URL, snippet).
Use this when the task needs current or external information you do not have locally: library documentation, error messages, release notes, API behavior. Do not use it for questions about the user's own codebase — use Grep/Glob/Read there.
The default engine is a free, key-less endpoint; results can be sparse or rate-limited, so phrase queries precisely. Use allowed_domains to restrict to trusted sites (e.g. official docs) or blocked_domains to filter out noisy ones.`,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only return results from these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Drop results from these domains' },
      count: { type: 'number', description: `Max results (default ${DEFAULT_COUNT}, max ${MAX_COUNT})` },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const engine = ctx.searchEngine ?? duckDuckGoSearch;
    const fetchImpl = ctx.fetch ?? fetch;
    let results;
    try {
      results = await engine(input.query, fetchImpl);
    } catch (e) {
      return { ok: false, error: `Web search failed: ${e.message}` };
    }
    if (Array.isArray(input.allowed_domains) && input.allowed_domains.length) {
      results = results.filter((r) => input.allowed_domains.some((d) => domainMatch(hostOf(r.url), d)));
    }
    if (Array.isArray(input.blocked_domains) && input.blocked_domains.length) {
      results = results.filter((r) => !input.blocked_domains.some((d) => domainMatch(hostOf(r.url), d)));
    }
    const count = Math.min(Math.max(input.count || DEFAULT_COUNT, 1), MAX_COUNT);
    results = results.slice(0, count);
    if (!results.length) return { ok: true, output: 'No results matched the query and domain filters.' };
    const lines = results.map((r, i) => {
      const head = `${i + 1}. ${r.title}\n   ${r.url}`;
      return r.snippet ? `${head}\n   ${r.snippet}` : head;
    });
    return { ok: true, output: lines.join('\n\n') };
  },
};
