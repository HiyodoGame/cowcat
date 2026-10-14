// MCP resources tools (docs/tools/tool-catalog.md:176-214): ListMcpResources
// enumerates resources on every connected server; ReadMcpResource fetches one
// by server + uri. Sources come from ctx.mcpClients (name -> McpClient).
const MAX_OUTPUT = 20_000;

function clientsOf(ctx) {
  const map = ctx.mcpClients;
  if (!map) return null;
  return map instanceof Map ? map : new Map(Object.entries(map));
}

export const ListMcpResourcesTool = {
  name: 'ListMcpResources',
  description: `List the MCP resources exposed by every connected MCP server. A resource is a data source (file, record, document) the server exposes as a stable URI, often with a MIME type.
When to use: before ReadMcpResource when you do not know the URIs a server exposes, or to survey which servers provide data rather than tools.
When NOT to use: invoking capabilities — that is what the mcp__<server>__<tool> tools are for.
Failure modes: servers that expose no resources are simply absent from the listing.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute(input, ctx) {
    const clients = clientsOf(ctx);
    if (!clients || clients.size === 0) {
      return { ok: true, output: 'No MCP servers connected.' };
    }
    const lines = [];
    for (const [server, client] of clients) {
      try {
        const resources = await client.listResources();
        for (const r of resources) {
          lines.push(`- [${server}] ${r.uri} | ${r.name || ''}${r.description ? ` — ${r.description}` : ''}${r.mimeType ? ` (${r.mimeType})` : ''}`);
        }
      } catch (e) {
        lines.push(`- ${server}: (resources/list failed: ${e.message})`);
      }
    }
    const out = lines.join('\n') || 'No MCP resources exposed by any connected server.';
    return { ok: true, output: out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[truncated]` : out };
  },
};

export const ReadMcpResourceTool = {
  name: 'ReadMcpResource',
  description: `Read the contents of an MCP resource by URI from a specific connected MCP server. Text content is returned verbatim; binary content is returned base64-encoded (annotated with its MIME type).
When to use: fetching the data behind a URI discovered via ListMcpResources.
Failure modes: unknown server names, stale URIs, and resources the server no longer serves all come back as errors — re-list and retry rather than guessing.`,
  input_schema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Name of the MCP server hosting the resource (as shown in ListMcpResources)' },
      uri: { type: 'string', description: 'Resource URI to read (exactly as listed)' },
    },
    required: ['server', 'uri'],
  },
  async execute(input, ctx) {
    const clients = clientsOf(ctx);
    const client = clients?.get(input.server);
    if (!client) {
      const known = clients && clients.size ? [...clients.keys()].join(', ') : '(none)';
      return { ok: false, error: `MCP server not connected: ${input.server}. Connected: ${known}` };
    }
    try {
      const { text, isError } = await client.readResource(input.uri);
      if (isError) return { ok: false, error: text };
      const out = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
