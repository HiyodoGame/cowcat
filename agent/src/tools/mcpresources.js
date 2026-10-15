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
  description: `List the MCP resources exposed by every connected MCP server. A resource is a data source (file, record, document) the server exposes as a stable URI, often with a MIME type. Servers that expose templated resources are listed as \`template <uriTemplate>\` — those URIs are not enumerable, but a concrete URI built from the template can be passed to ReadMcpResource.
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
      // Templated resources are not enumerable as URIs, but the model still needs
      // to know they exist (ReadMcpResource takes a concrete URI built from one).
      try {
        const templates = await client.listResourceTemplates();
        for (const t of templates) {
          lines.push(`- [${server}] template ${t.uriTemplate} | ${t.name || ''}${t.description ? ` — ${t.description}` : ''}`);
        }
      } catch { /* servers without templates stay silent */ }
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

// §15/§16 of the tool catalog. Server selection: an explicit name, or the only
// connected server when the model omits it (with more than one connected the
// guess would be a coin flip, so it is an error listing the candidates).
function pickClient(ctx, server) {
  const clients = clientsOf(ctx);
  if (!clients || clients.size === 0) return { error: 'No MCP servers connected.' };
  if (server) {
    const client = clients.get(server);
    if (!client) return { error: `MCP server not connected: ${server}. Connected: ${[...clients.keys()].join(', ')}` };
    return { client, server };
  }
  if (clients.size === 1) {
    const [name, client] = [...clients.entries()][0];
    return { client, server: name };
  }
  return { error: `server is required when more than one MCP server is connected: ${[...clients.keys()].join(', ')}` };
}

export const SubscribeMcpResourceTool = {
  name: 'SubscribeMcpResource',
  description: `Subscribe to change notifications for one MCP resource. The server then sends notifications/resources/updated whenever that resource changes; CowCat surfaces the update to the user (it does not wake the model or re-read the resource).
When to use: when the user wants to be told about changes to a resource at a known URI (a file, a record, a document).
When NOT to use: for one-off reads — that is ReadMcpResource.
Failure modes: servers that do not advertise the subscribe capability are refused up front; the uri must be one the server exposes (see ListMcpResources).`,
  input_schema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Name of the MCP server (omit when exactly one server is connected)' },
      uri: { type: 'string', description: 'Resource URI to watch (as listed by ListMcpResources)' },
      reason: { type: 'string', description: 'Why this resource matters — echoed back with each update' },
    },
    required: ['uri'],
  },
  async execute(input, ctx) {
    const picked = pickClient(ctx, input.server);
    if (picked.error) return { ok: false, error: picked.error };
    const { client, server } = picked;
    const subs = ctx.mcpSubs;
    if (!subs) return { ok: false, error: 'subscription registry unavailable' };
    // Register BEFORE the round trip: a server may push the first update as soon
    // as it has been subscribed, and that update has to be attributed to this
    // subscription rather than dropped as "not subscribed".
    const entry = subs.add({ server, uri: input.uri, reason: input.reason || '' });
    try {
      await client.subscribe(input.uri);
    } catch (e) {
      subs.remove({ subscriptionId: entry.id }); // rolled back: it never took
      return { ok: false, error: e.message };
    }
    return {
      ok: true,
      output: `Subscribed to ${input.uri} on ${server} (${entry.id})${input.reason ? ` — ${input.reason}` : ''}`,
      subscribed: true,
      subscriptionId: entry.id,
    };
  },
};

export const UnsubscribeMcpResourceTool = {
  name: 'UnsubscribeMcpResource',
  description: `Stop watching MCP resource(s) previously subscribed with SubscribeMcpResource. Any one of server / uri / subscriptionId is enough to identify the subscription(s); with none of them nothing is unsubscribed.
When to use: when the user no longer wants change notifications for a resource.
Failure modes: works on the local registry, so an entry always disappears even if the server-side unsubscribe fails (that failure is reported).`,
  input_schema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Unsubscribe every subscription for this server' },
      uri: { type: 'string', description: 'Unsubscribe this resource URI' },
      subscriptionId: { type: 'string', description: 'Unsubscribe by the exact id returned from SubscribeMcpResource' },
    },
  },
  async execute(input, ctx) {
    const subs = ctx.mcpSubs;
    if (!subs) return { ok: false, error: 'subscription registry unavailable' };
    const removed = subs.remove(input);
    if (!removed.length) {
      return { ok: false, error: 'No matching subscription (give server, uri or subscriptionId)' };
    }
    const clients = clientsOf(ctx);
    const failures = [];
    for (const e of removed) {
      const client = clients?.get(e.server);
      // A server that is gone no longer holds the subscription either.
      if (!client) continue;
      try { await client.unsubscribe(e.uri); } catch (err) { failures.push(`${e.server} ${e.uri}: ${err.message}`); }
    }
    const which = removed.map((e) => e.id).join(', ');
    if (failures.length) {
      return { ok: true, output: `Removed ${removed.length} subscription(s) locally (${which}), but: ${failures.join('; ')}`, unsubscribed: true };
    }
    return { ok: true, output: `Unsubscribed ${removed.length} subscription(s): ${which}`, unsubscribed: true };
  },
};
