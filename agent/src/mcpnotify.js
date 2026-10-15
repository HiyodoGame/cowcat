// Classify an MCP server->client notification into something the host can act on
// (docs/mcp-server-channel-plan.md §3.6). Deliberately free of UI and of the
// tool registry: the host decides how a line is printed and what "refresh the
// tools" means, which keeps this unit-testable.
//
// Notifications CowCat deliberately does nothing with are reported as
// `ignore` with a reason rather than silently swallowed — the reason is what
// the tests assert on, and what a future `--debug` surface would print.
const MAX_TEXT = 2_000;

function logText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  try { return JSON.stringify(data); } catch { return String(data); }
}

export function classifyMcpNotification(method, params = {}) {
  switch (method) {
    case 'notifications/message':
      // logging: { level, logger?, data }
      return { kind: 'log', level: params.level || 'info', text: logText(params.data).slice(0, MAX_TEXT) };
    case 'notifications/tools/list_changed':
      return { kind: 'list-changed', what: 'tools' };
    case 'notifications/prompts/list_changed':
      return { kind: 'list-changed', what: 'prompts' };
    case 'notifications/resources/list_changed':
      return { kind: 'list-changed', what: 'resources' };
    case 'notifications/resources/updated':
      return params.uri
        ? { kind: 'resource-updated', uri: params.uri }
        : { kind: 'ignore', why: 'resources/updated without a uri' };
    case 'notifications/progress':
      return { kind: 'ignore', why: 'progress' };
    case 'notifications/cancelled':
      return { kind: 'ignore', why: 'cancelled' };
    default:
      return { kind: 'ignore', why: `unknown notification: ${method}` };
  }
}

// One line for the terminal. Kept here (not in bin) so the format is testable
// and identical between the TUI and line mode.
export function formatMcpNotification(server, note) {
  if (note.kind === 'log') return `[${server}] ${note.level}: ${note.text}`;
  if (note.kind === 'resource-updated') return `[${server}] resource updated: ${note.uri}`;
  if (note.kind === 'list-changed') return `[${server}] ${note.what} changed`;
  return `[${server}] ${note.why || 'notification'}`;
}

// Run one notification through the host's print/toast/refresh callbacks and say
// what was done with it. Every branch is reachable from a unit test without a
// CLI, and `acted: false` records the deliberate silences (progress, unknown
// methods, updates for resources nobody subscribed to).
export async function handleMcpNotification({ server, method, params = {}, subs = null, print = null, toast = null, refresh = null }) {
  const note = classifyMcpNotification(method, params);
  if (note.kind === 'ignore') return { ...note, acted: false };

  if (note.kind === 'list-changed') {
    // A stale tool list is worse than a missing tool: re-read it.
    if (refresh) await refresh(server);
    return { kind: 'list-changed', what: note.what, acted: !!refresh, why: refresh ? undefined : 'no refresh handler' };
  }

  const say = (variant, text) => {
    // Toast titles carry the server already; the terminal line gets a marker so
    // a notification is visually distinct from the conversation.
    if (toast) toast(variant, 'MCP', text);
    else if (print) print(`ⓘ ${text}`);
  };

  if (note.kind === 'resource-updated') {
    const watching = subs ? subs.find(note.uri) : [];
    if (!watching.length) {
      // The server may send updates for anything it likes; only speak up when
      // the user asked to be told about this resource.
      return { kind: 'resource-updated', uri: note.uri, acted: false, why: 'not subscribed' };
    }
    const why = watching.map((w) => w.reason).filter(Boolean).join('; ');
    say('info', `${formatMcpNotification(server, note)}${why ? ` (${why})` : ''}`);
    return { kind: 'resource-updated', uri: note.uri, acted: true };
  }

  say(note.level === 'error' ? 'error' : 'info', formatMcpNotification(server, note));
  return { kind: 'log', acted: true };
}

