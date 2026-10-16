// MCP client. OAuth is out of scope. Transports:
// stdio (JSON-RPC 2.0 over newline-delimited stdio) and http (POST JSON-RPC;
// SSE bodies parsed). Config: ~/.cowcat/mcp.json + <cwd>/.cowcat/mcp.json,
// project level wins per server name.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cowcatHome, writeState, PKG_VERSION } from './config.js';
import { guardStdin } from './childio.js';
import { SseParser } from './sse.js';

// One SSE frame's data is a JSON-RPC message for MCP. Non-JSON frames (and the
// SSE-level `[DONE]` sentinel) are ignored rather than failing the call.
function parseFrame(data) {
  const raw = String(data || '').trim();
  if (!raw || raw === '[DONE]') return null;
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg === 'object' ? msg : null;
  } catch { return null; }
}

// Flatten one MCP content block to text. Prompts, tool results and resources all
// carry the same shape; non-text parts are annotated so the model knows
// something was there (and what kind) instead of silently dropping it.
function contentToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (c.type === 'text') return c.text ?? '';
  if (c.type === 'resource') {
    const r = c.resource || {};
    if (r.text != null) return r.text;
    return `[resource: ${r.uri || c.uri || '(embedded)'}]`;
  }
  if (c.type === 'image') return `[image: ${c.mimeType || 'image'}]`;
  if (c.type === 'audio') return `[audio: ${c.mimeType || 'audio'}]`;
  return `[${c.type || 'unknown'}]`;
}

const PROTOCOL_VERSION = '2024-11-05';
const getTimeout = () => Number(process.env.COWCAT_MCP_TIMEOUT) || 60_000;
const MAX_OUTPUT = 20_000;
// server->client channel (Streamable HTTP GET stream) reconnect policy: the
// official SDK uses exponential backoff with these shapes, and honouring the
// server's `retry:` field when it sends one. The knobs exist so tests do not
// have to sit through real backoff.
const STREAM_INITIAL_DELAY_MS = 1_000;
const STREAM_MAX_DELAY_MS = 30_000;
const STREAM_MAX_ATTEMPTS = 5;
// A stream that held for this long before dropping counts as healthy: the next
// drop is a new incident, not a retry of the same one. Without this a server
// that accepts the connection and closes it immediately would reset the backoff
// on every attempt and be hammered forever.
const STREAM_HEALTHY_MS = 5_000;
const getStreamInitialDelay = () => Number(process.env.COWCAT_MCP_STREAM_RETRY_MS) || STREAM_INITIAL_DELAY_MS;
const getStreamMaxAttempts = () => Number(process.env.COWCAT_MCP_STREAM_ATTEMPTS) || STREAM_MAX_ATTEMPTS;
// SIGTERM first (graceful), SIGKILL after this grace period — a server that
// ignores SIGTERM would otherwise outlive the session. COWCAT_MCP_KILL_GRACE
// overrides it (tests use a short grace).
const KILL_GRACE_MS = 3_000;
const getKillGrace = () => Number(process.env.COWCAT_MCP_KILL_GRACE) || KILL_GRACE_MS;
// Errors that mean "the command could not be launched as given", not "the
// server misbehaved": ENOENT (bare name with no .exe match), EINVAL (Node
// refuses to spawn a .cmd/.bat without a shell).
const LAUNCH_ERRORS = ['ENOENT', 'EINVAL', 'UNKNOWN'];

// Quote one argv element for a `cmd.exe /c` command line. Needed because the
// Windows shims (npx/npm/yarn…) are .cmd files: Node cannot spawn them directly
// and `.cmd` reaches the child as a raw string passed through %*. Backslashes
// before a closing quote must be doubled or they escape it.
function winQuote(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^()]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') { backslashes++; out += ch; continue; }
    if (ch === '"') { out += `${'\\'.repeat(backslashes)}\\"`; backslashes = 0; continue; }
    backslashes = 0;
    out += ch;
  }
  return `${out + '\\'.repeat(backslashes)}"`;
}

// --- config ------------------------------------------------------------------

export function loadMcpConfigs(cwd) {
  const servers = {};
  const read = (file) => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')).mcpServers;
      // Only a plain object is a server map; an array/string here would make
      // Object.assign spread indices/characters into bogus server entries.
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  };
  Object.assign(servers, read(join(cowcatHome(), 'mcp.json')));          // user level
  Object.assign(servers, read(join(cwd, '.cowcat', 'mcp.json')));       // project overrides
  return servers;
}

export function mcpTrustedList(cfg) {
  return Array.isArray(cfg.mcpTrusted) ? cfg.mcpTrusted : [];
}

export function trustMcpServer(cfg, name) {
  const next = writeState((state) => {
    state.mcpTrusted = Array.from(new Set([...(Array.isArray(state.mcpTrusted) ? state.mcpTrusted : []), name]));
    return state;
  });
  cfg.mcpTrusted = next.mcpTrusted;
  return next;
}

// --- stdio transport ----------------------------------------------------------

class StdioTransport {
  constructor(name, def, { deadline = null } = {}) {
    this.name = name;
    this.def = def;
    this.deadline = deadline; // absolute ms timestamp from the connect budget
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.lastStderr = '';
    // Server->client messages (notifications, and requests like sampling): stdio
    // delivers them on the same stream as responses, unsolicited.
    this.onMessage = null;
  }
  // Per-call timeout, clamped to whatever is left of the connect budget so a
  // single hung server cannot outlast the budget.
  _timeout() {
    const base = getTimeout();
    if (!this.deadline) return base;
    return Math.max(1, Math.min(base, this.deadline - Date.now()));
  }
  connect() {
    return new Promise((resolve, reject) => {
      this._launch().then((child) => {
        this.child = child;
        const to = setTimeout(() => reject(new Error('connect timeout')), this._timeout());
        child.stdout.on('data', (chunk) => this._onData(chunk));
        // Keep the last stderr line: when a server dies during startup that line
        // is usually the actual reason ("Missing API key", "unknown option").
        // Without it every failed launch reported only "server exited (code 1)".
        child.stderr.on('data', (chunk) => {
          const s = chunk.toString('utf8').replace(/\s+/g, ' ').trim();
          if (s) this.lastStderr = s.length > 400 ? s.slice(-400) : s;
        });
        child.on('error', (e) => { clearTimeout(to); reject(e); });
        child.on('exit', (code) => {
          for (const { reject: rj } of this.pending.values()) rj(this._exitError(code));
          this.pending.clear();
        });
        this.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'cowcat', version: PKG_VERSION },
        }).then((res) => {
          clearTimeout(to);
          this.notify('notifications/initialized', {});
          resolve(res);
        }).catch((e) => { clearTimeout(to); reject(e); });
      }).catch(reject);
    });
  }
  _exitError(code) {
    return new Error(`server exited (code ${code})${this.lastStderr ? `: ${this.lastStderr}` : ''}`);
  }
  _spawnOnce(command, args, opts) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, opts);
      } catch (e) {
        // Node throws synchronously (EINVAL) for a .cmd/.bat without a shell
        reject(e);
        return;
      }
      child.once('error', reject);
      child.once('spawn', () => {
        child.removeListener('error', reject);
        // Writes to a server that has just died raise EPIPE on the stream; the
        // guard keeps that from becoming an uncaught exception (src/childio.js).
        guardStdin(child);
        resolve(child);
      });
    });
  }
  // Windows cannot exec the .cmd shims directly, and the documented config says
  // "command": "npx" — so a failed direct launch is retried once through
  // cmd.exe. The direct attempt runs first, leaving .exe/absolute-path setups
  // exactly as before; if the retry also fails the ORIGINAL error is reported
  // (it names the missing command instead of cmd.exe's exit code).
  _launch() {
    const command = this.def.command;
    const args = this.def.args || [];
    const opts = { env: { ...process.env, ...(this.def.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] };
    return this._spawnOnce(command, args, opts).catch(async (e) => {
      if (process.platform !== 'win32' || !LAUNCH_ERRORS.includes(e.code)) throw e;
      const line = [command, ...args].map(winQuote).join(' ');
      const comspec = process.env.ComSpec || 'cmd.exe';
      try {
        // windowsVerbatimArguments: without it Node re-quotes the command string
        // and cmd.exe ends up looking for a program literally named `"npx"`.
        return await this._spawnOnce(
          comspec,
          ['/d', '/s', '/c', `"${line}"`],
          { ...opts, windowsVerbatimArguments: true },
        );
      } catch {
        throw e;
      }
    });
  }
  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: rs, reject: rj } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rj(new Error(msg.error.message || JSON.stringify(msg.error)));
        else rs(msg.result);
        continue;
      }
      // No matching id: a notification, or a request the server is making of us.
      // Both used to be dropped on the floor.
      if (msg.method) {
        try { this.onMessage?.(msg); } catch { /* consumer blew up: not our problem */ }
      }
    }
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A server that already exited has a destroyed stdin pipe: writing to it
      // throws or emits an async 'error'. Surface a clear rejection instead.
      if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdin.writable) {
        reject(this._exitError(this.child.exitCode ?? 'signal'));
        return;
      }
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(this._timeout() / 1000)}s`));
      }, this._timeout());
      this.pending.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        clearTimeout(to);
        this.pending.delete(id);
        reject(new Error(`failed to write to server: ${e.message}`));
      }
    });
  }
  notify(method, params) {
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* dead */ }
  }
  // Reply to a server-initiated request (sampling/elicitation/ping). Without a
  // reply the server waits forever.
  respond(id, result, error) {
    const msg = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    try { this.child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* dead */ }
  }
  // stdio has no separate server->client channel: notifications arrive on the
  // same pipe, so there is nothing to open.
  startStream() {}
  stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Windows: child.kill() only terminates the direct child, so a shim launch
    // (cmd.exe → npx.cmd → node) would leave the server itself orphaned.
    // taskkill /T walks the process tree.
    if (process.platform === 'win32') {
      const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\taskkill.exe` : 'taskkill';
      try {
        const tk = spawn(exe, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        // if taskkill is itself unavailable, fall back to a plain kill
        tk.on('error', () => { try { child.kill(); } catch { /* noop */ } });
      } catch {
        try { child.kill(); } catch { /* noop */ }
      }
      return;
    }
    try { child.kill(); } catch { /* noop */ }
    // escalate if it ignores SIGTERM; unref so the timer never holds the loop
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }
    }, getKillGrace());
    if (t.unref) t.unref();
    child.once('exit', () => clearTimeout(t));
  }
}

// --- http transport (POST JSON-RPC; parses SSE data lines or plain JSON) -------

class HttpTransport {
  constructor(name, def, fetchImpl = fetch, { deadline = null } = {}) {
    this.name = name;
    this.def = def;
    this.fetch = fetchImpl;
    this.deadline = deadline;
    this.nextId = 1;
    this.sessionId = null; // assigned by the server on initialize (Streamable HTTP)
    // server->client channel state (see startStream)
    this.onMessage = null;
    this.streamCtrl = null;
    this.streamTimer = null;
    this.streamStopped = true;
    this.streamUnsupported = false; // server answered 404/405 to GET: never retry
    this.streamAttempt = 0;
    this.lastEventId = null; // resumption token from the last `id:` frame we saw
    this.serverRetryMs = null; // server's `retry:` preference, in ms
    this.streamOpenedAt = 0; // when the current stream was accepted
  }
  _timeout() {
    const base = getTimeout();
    if (!this.deadline) return base;
    return Math.max(1, Math.min(base, this.deadline - Date.now()));
  }
  async connect() {
    const res = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cowcat', version: PKG_VERSION },
    });
    // Per spec this is a notification: POST it without an id and never wait for
    // a JSON-RPC result (servers answer 202 with an empty body). Sending it as
    // a request with an id depended on the server tolerating an unmatched id.
    await this.notify('notifications/initialized', {});
    return res;
  }
  _headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.def.headers || {}) };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }
  async notify(method, params) {
    try {
      await this.fetch(this.def.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      });
    } catch { /* notification delivery is best-effort */ }
  }
  async request(method, params) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this._timeout());
    try {
      const res = await this.fetch(this.def.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: ctrl.signal,
      });
      // Streamable HTTP hands the session id back in a response header; a
      // server that mints one requires it on every later request.
      const sid = res.headers?.get?.('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await this._readResult(res);
    } finally {
      clearTimeout(to);
    }
  }
  // Read the response and resolve the moment the matching JSON-RPC frame shows
  // up. Buffering the whole body first (`await res.text()`) stalled every call
  // until the timeout: an SSE stream is allowed to stay OPEN after the response
  // (keep-alive comment frames, further notifications — the official SDK's
  // keep-alive and any holding proxy do exactly that), so waiting for the stream
  // to end waits for a server that has already answered.
  async _readResult(res) {
    const body = res.body;
    // Fake fetches (unit tests) and empty bodies have no stream: read it all.
    if (!body || typeof body.getReader !== 'function') {
      const text = typeof res.text === 'function' ? await res.text() : '';
      return this._parseBody(text);
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let raw = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        for (const ev of parser.feed(chunk)) {
          const msg = parseFrame(ev.data);
          if (!msg) continue;
          if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
            return msg.result;
          }
          // A notification (or a server->client request) arriving on the POST
          // stream: hand it to the client instead of dropping it.
          if (msg.method) this._dispatch(msg);
        }
        // a plain JSON body arrives whole and has no `data:` prefix
        const t = raw.trim();
        if (t.startsWith('{') && t.endsWith('}')) {
          try { return this._parseBody(t); } catch { /* incomplete: keep reading */ }
        }
      }
    } finally {
      // stop reading (and let the server close) — we already have our answer
      try { await reader.cancel(); } catch { /* stream already gone */ }
    }
    return this._parseBody(raw);
  }
  // Notifications and server->client requests travel to whatever consumer was
  // wired up (McpClient). Errors there must not break the transport loop.
  _dispatch(msg) {
    try { this.onMessage?.(msg); } catch { /* consumer blew up: not our problem */ }
  }
  // Body is either a plain JSON-RPC object or a whole SSE stream (fake fetches
  // in unit tests hand us text). The stream may carry several frames
  // (notifications interleaved with the answer), so collect them all and pick
  // the response frame — taking the first `data:` line used to parse a
  // notification and die.
  _parseBody(text) {
    if (text.includes('data:')) {
      const parser = new SseParser();
      const frames = [...parser.feed(text), ...parser.flush()]
        .map((ev) => parseFrame(ev.data))
        .filter(Boolean);
      const msg = frames.find((f) => f.id != null && (f.result !== undefined || f.error !== undefined));
      if (!msg) throw new Error('no JSON-RPC response frame in event stream');
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    }
    const msg = JSON.parse(text);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }
  // --- server->client channel (GET SSE) -------------------------------------
  //
  // Streamable HTTP servers MAY expose a long-lived GET stream for messages the
  // client did not ask for (logging, list_changed, resources/updated) and for
  // server-initiated requests. 405/404 means "this endpoint has no stream" —
  // retrying is pointless, so it is remembered and never retried. A dropped
  // stream is re-opened with exponential backoff and, when we saw an id, a
  // Last-Event-ID header so a resumable server replays what we missed (the
  // official SDK client behaves the same way).
  startStream({ onError = null } = {}) {
    this.streamStopped = false;
    this._openStream(onError);
  }
  async _openStream(onError) {
    if (this.streamStopped || this.streamUnsupported) return;
    const ctrl = new AbortController();
    this.streamCtrl = ctrl;
    try {
      const headers = { ...this._headers(), accept: 'text/event-stream' };
      if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
      const res = await this.fetch(this.def.url, { method: 'GET', headers, signal: ctrl.signal });
      if (res.status === 404 || res.status === 405) { this.streamUnsupported = true; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sid = res.headers?.get?.('mcp-session-id');
      if (sid) this.sessionId = sid;
      this.streamOpenedAt = Date.now();
      await this._readStream(res);
    } catch (e) {
      if (!this.streamStopped && !this.streamUnsupported) this._scheduleReconnect(onError, e);
      return;
    }
    // The server closed the stream (a reconnecting server, a proxy idle timeout):
    // open it again unless the client is going away.
    if (!this.streamStopped && !this.streamUnsupported) this._scheduleReconnect(onError);
  }
  async _readStream(res) {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          if (ev.id) this.lastEventId = ev.id;
          if (ev.retry != null) this.serverRetryMs = ev.retry;
          const msg = parseFrame(ev.data);
          if (msg) {
            // The server actually talked to us: this stream was real, so the
            // next drop starts over instead of continuing a retry streak.
            this.streamAttempt = 0;
            this._dispatch(msg);
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* stream already gone */ }
    }
  }
  _scheduleReconnect(onError, err) {
    // A stream that survived for a while died of something new, not of the same
    // fault: give the backoff a fresh budget.
    if (this.streamOpenedAt && Date.now() - this.streamOpenedAt >= STREAM_HEALTHY_MS) this.streamAttempt = 0;
    const attempt = this.streamAttempt++;
    if (attempt >= getStreamMaxAttempts()) {
      // Give up (and say so once) instead of hammering a broken endpoint.
      this.streamUnsupported = true;
      try { onError?.(err || new Error(`server->client stream dropped (gave up after ${attempt} retries)`)); } catch { /* consumer */ }
      return;
    }
    const base = this.serverRetryMs ?? getStreamInitialDelay();
    const delay = Math.min(base * 2 ** attempt, STREAM_MAX_DELAY_MS);
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this._openStream(onError);
    }, delay);
    if (this.streamTimer.unref) this.streamTimer.unref();
  }
  // Reply to a server-initiated request by POSTing the response message, per the
  // Streamable HTTP transport (the GET stream is server->client only).
  async respond(id, result, error) {
    const msg = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    try {
      await this.fetch(this.def.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(msg) });
    } catch { /* best effort: the server will time the request out */ }
  }
  stop() {
    this.streamStopped = true;
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    try { this.streamCtrl?.abort(); } catch { /* already gone */ }
    this.streamCtrl = null;
  }
}

// --- client -------------------------------------------------------------------

export class McpClient {
  constructor(name, def, { fetchImpl, deadline = null } = {}) {
    this.name = name;
    this.def = def;
    this.transport = def.url
      ? new HttpTransport(name, def, fetchImpl, { deadline })
      : new StdioTransport(name, def, { deadline });
    this.tools = [];
    this.prompts = [];
    this.capabilities = {};
    // Server->client plumbing. `onNotification(method, params)` is set by the
    // host (bin) before connect; `onChannelError(err)` reports a server->client
    // stream that gave up. Both are optional — the client stays UI-free.
    this.onNotification = null;
    this.onChannelError = null;
    this.transport.onMessage = (msg) => this._handleServerMessage(msg);
  }
  // A message with an id is a REQUEST from the server (sampling / elicitation /
  // roots). None of those are implemented, so replying with Method-not-found is
  // the correct behaviour — silence would leave the server waiting. `ping` is
  // the one we can answer honestly.
  _handleServerMessage(msg) {
    if (msg.id != null && msg.method) {
      if (msg.method === 'ping') this.transport.respond(msg.id, {});
      else this.transport.respond(msg.id, null, { code: -32601, message: `Method not found: ${msg.method}` });
      return;
    }
    if (!msg.method) return;
    try { this.onNotification?.(msg.method, msg.params || {}); } catch { /* host blew up */ }
  }
  // Open the server->client channel where the transport needs to (HTTP GET SSE).
  startChannel() {
    this.transport.startStream?.({ onError: (e) => this.onChannelError?.(e) });
  }
  // Re-read the tool/prompt lists after a *_list_changed notification. The host
  // is responsible for re-registering anything built from them.
  async refresh() {
    this.tools = await this._listAllTools();
    this.prompts = await this._listAllPrompts();
    return this.tools;
  }
  async connect() {
    // Capabilities decide what else we may ask for (prompts list is optional);
    // both transports hand back the initialize result.
    this.capabilities = (await this.transport.connect()) || {};
    this.tools = await this._listAllTools();
    this.prompts = await this._listAllPrompts();
    // Ask for log messages when the server offers them: a conforming server
    // stays silent until a level has been chosen, so "logging never arrives" is
    // usually this request missing, not the server misbehaving. A failure here
    // must not fail the connection.
    try { await this.setLogLevel(); } catch { /* logging stays off */ }
    return this;
  }
  // logging/setLevel is a REQUEST (the server answers), sent once after connect.
  // COWCAT_MCP_LOG_LEVEL picks the level; without the capability nothing is sent.
  async setLogLevel(level = process.env.COWCAT_MCP_LOG_LEVEL || 'info') {
    if (!this.capabilities?.capabilities?.logging) return false;
    await this.transport.request('logging/setLevel', { level });
    return true;
  }
  // prompts/list is optional and paginated like tools/list: a server without the
  // capability answers Method not found, and a cursor hides the rest of the page
  // set. Discovery is best-effort — it must never fail the connection.
  async _listAllPrompts() {
    const all = [];
    let cursor;
    try {
      for (let page = 0; page < 50; page++) { // hard stop against a cursor loop
        const res = await this.transport.request('prompts/list', cursor ? { cursor } : {});
        all.push(...(res.prompts || []));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
    } catch { return []; }
    return all;
  }
  // prompts/get returns messages rather than a single string. CowCat has one
  // injection point per turn, so the messages are flattened into one user turn;
  // non-user roles are labelled so the model is not told it said them.
  async getPrompt(name, args = {}) {
    const res = await this.transport.request('prompts/get', { name, arguments: args });
    const parts = [];
    for (const m of res.messages || []) {
      const text = contentToText(m.content);
      if (!text) continue;
      parts.push(m.role && m.role !== 'user' ? `[${m.role}] ${text}` : text);
    }
    return { description: res.description || '', text: parts.join('\n\n') || '(empty prompt)' };
  }
  // tools/list is paginated: keep pulling while the server hands back a cursor.
  // Reading only the first page silently hid every tool past the server's page
  // size (a hidden tool is worse than a missing one — the model never learns
  // it exists).
  async _listAllTools() {
    const all = [];
    let cursor;
    for (let page = 0; page < 50; page++) { // hard stop against a cursor loop
      const res = await this.transport.request('tools/list', cursor ? { cursor } : {});
      all.push(...(res.tools || []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return all;
  }
  async callTool(name, args) {
    const res = await this.transport.request('tools/call', { name, arguments: args });
    const parts = [];
    for (const c of res.content || []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'resource') parts.push(`[resource: ${c.uri || '(embedded)'}]`);
      else parts.push(`[${c.type}]`);
    }
    const out = parts.join('\n') || '(no content)';
    return { text: out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[truncated]` : out, isError: !!res.isError };
  }
  // MCP resources: resources/list + resources/read
  // over whichever transport is in use; errors surface to the caller.
  // resources/list is paginated like tools/list: a server that hands back a
  // cursor hides every resource past the first page.
  async listResources() {
    const all = [];
    let cursor;
    for (let page = 0; page < 50; page++) { // hard stop against a cursor loop
      const res = await this.transport.request('resources/list', cursor ? { cursor } : {});
      all.push(...(res.resources || []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return all;
  }
  // resources/templates/list: dynamic (templated) resources. Optional and
  // paginated like the rest — a server without templates answers Method not
  // found, which must not fail the caller.
  async listResourceTemplates() {
    const all = [];
    let cursor;
    for (let page = 0; page < 50; page++) { // hard stop against a cursor loop
      let res;
      try {
        res = await this.transport.request('resources/templates/list', cursor ? { cursor } : {});
      } catch { return all; }
      all.push(...(res.resourceTemplates || []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return all;
  }
  async readResource(uri) {
    const res = await this.transport.request('resources/read', { uri });
    const contents = res.contents || [];
    const parts = contents.map((c) => {
      if (c.text != null) return c.text;
      if (c.blob != null) return `[base64 ${c.mimeType || 'application/octet-stream'}] ${c.blob}`;
      return `[${c.mimeType || 'unknown'}]`;
    });
    return { text: parts.join('\n') || '(empty resource)', isError: !!res.isError };
  }
  // resources/subscribe + unsubscribe: updates arrive as
  // notifications/resources/updated on the server->client channel. Servers
  // advertise this separately (capabilities.resources.subscribe) and answering
  // Method not found at call time is far less clear than refusing up front.
  _assertSubscribable() {
    // `capabilities` holds the initialize RESULT, so the advertised block sits
    // one level down.
    if (!this.capabilities?.capabilities?.resources?.subscribe) {
      throw new Error(`${this.name} does not support resources/subscribe`);
    }
  }
  async subscribe(uri) {
    this._assertSubscribable();
    await this.transport.request('resources/subscribe', { uri });
    return true;
  }
  async unsubscribe(uri) {
    this._assertSubscribable();
    await this.transport.request('resources/unsubscribe', { uri });
    return true;
  }
  stop() { this.transport.stop(); }
}

// Convert an MCP tool definition into a CowCat registry tool.
export function mcpToolAdapter(client, serverName, tool) {
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: `[${serverName}] ${tool.description || 'MCP tool'}`,
    input_schema: tool.inputSchema || { type: 'object', properties: {} },
    execute: (input) => client.callTool(tool.name, input)
      .then(({ text, isError }) => (isError ? { ok: false, error: text } : { ok: true, output: text }))
      .catch((e) => ({ ok: false, error: e.message })),
  };
}

export async function connectAll(servers, { fetchImpl, deadline = null, onNotification = null, onChannelError = null } = {}) {
  const names = Object.keys(servers);
  const results = await Promise.all(names.map(async (name) => {
    const client = new McpClient(name, servers[name], { fetchImpl, deadline });
    // Wired BEFORE connect so notifications emitted during/after initialize
    // (logging, list_changed) are not lost.
    if (onNotification) client.onNotification = (method, params) => onNotification(name, method, params, client);
    if (onChannelError) client.onChannelError = (e) => onChannelError(name, e);
    try {
      await client.connect();
      client.startChannel();
      return { name, client, ok: true, tools: client.tools };
    } catch (e) {
      client.stop();
      return { name, client: null, ok: false, error: e.message, tools: [] };
    }
  }));
  return results;
}
