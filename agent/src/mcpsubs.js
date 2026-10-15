// MCP resource subscriptions (docs/tools/tool-catalog.md §15/§16).
//
// A subscription is the triple (server, uri, reason): `server` says who to ask,
// `uri` what to watch, `reason` is echoed back in the update notification so the
// user remembers why they cared. The three stay loosely coupled on purpose —
// unsubscribing may name any one of them, so the registry has to be queryable by
// each dimension.
//
// The id is derived (not random) so it is stable across restarts and readable in
// a tool result: `mcp:<server>:<uri>`.
export function subscriptionIdOf(server, uri) {
  return `mcp:${server}:${uri}`;
}

export class McpSubscriptions {
  constructor() {
    this.entries = new Map(); // id -> { id, server, uri, reason, at }
  }
  // Idempotent: re-subscribing the same (server, uri) refreshes the reason.
  add({ server, uri, reason = '' }) {
    const id = subscriptionIdOf(server, uri);
    const entry = { id, server, uri, reason, at: Date.now() };
    this.entries.set(id, entry);
    return entry;
  }
  // Any one of the three dimensions is enough. Returns what was removed so the
  // caller can unsubscribe on the wire and report accurately.
  remove({ server, uri, subscriptionId } = {}) {
    if (!server && !uri && !subscriptionId) return [];
    const removed = [];
    for (const [id, e] of this.entries) {
      if (subscriptionId && id !== subscriptionId) continue;
      if (server && e.server !== server) continue;
      if (uri && e.uri !== uri) continue;
      removed.push(e);
      this.entries.delete(id);
    }
    return removed;
  }
  // resources/updated carries only a uri: find every watch on it.
  find(uri) {
    return [...this.entries.values()].filter((e) => e.uri === uri);
  }
  list() {
    return [...this.entries.values()];
  }
}
