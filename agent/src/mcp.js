// MCP client (docs/protocol/README.md; OAuth out of scope). Transports:
// stdio (JSON-RPC 2.0 over newline-delimited stdio) and http (POST JSON-RPC;
// SSE bodies parsed). Config: ~/.cowcat/mcp.json + <cwd>/.cowcat/mcp.json,
// project level wins per server name.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cowcatHome, writeState } from './config.js';

const PROTOCOL_VERSION = '2024-11-05';
const getTimeout = () => Number(process.env.COWCAT_MCP_TIMEOUT) || 60_000;
const MAX_OUTPUT = 20_000;
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
          clientInfo: { name: 'cowcat', version: '0.5.0' },
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
      child.once('spawn', () => { child.removeListener('error', reject); resolve(child); });
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
  }
  _timeout() {
    const base = getTimeout();
    if (!this.deadline) return base;
    return Math.max(1, Math.min(base, this.deadline - Date.now()));
  }
  async connect() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cowcat', version: '0.5.0' },
    });
    // Per spec this is a notification: POST it without an id and never wait for
    // a JSON-RPC result (servers answer 202 with an empty body). Sending it as
    // a request with an id depended on the server tolerating an unmatched id.
    await this.notify('notifications/initialized', {});
    return {};
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
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return this._parseBody(text);
    } finally {
      clearTimeout(to);
    }
  }
  // Body is either a plain JSON-RPC object or an SSE stream. The stream may
  // carry several `data:` frames (notifications interleaved with the answer),
  // so scan them all and pick the response frame — taking the first `data:`
  // line used to parse a notification and die.
  _parseBody(text) {
    if (text.includes('data:')) {
      const frames = [];
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try { frames.push(JSON.parse(raw)); } catch { /* skip non-JSON frame */ }
      }
      const msg = frames.find((f) => f && f.id != null && (f.result !== undefined || f.error !== undefined));
      if (!msg) throw new Error('no JSON-RPC response frame in event stream');
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    }
    const msg = JSON.parse(text);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }
  stop() { /* stateless */ }
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
  }
  async connect() {
    await this.transport.connect();
    this.tools = await this._listAllTools();
    return this;
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
  // MCP resources (docs/tools/tool-catalog.md): resources/list + resources/read
  // over whichever transport is in use; errors surface to the caller.
  async listResources() {
    const res = await this.transport.request('resources/list', {});
    return res.resources || [];
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

export async function connectAll(servers, { fetchImpl, deadline = null } = {}) {
  const names = Object.keys(servers);
  const results = await Promise.all(names.map(async (name) => {
    const client = new McpClient(name, servers[name], { fetchImpl, deadline });
    try {
      await client.connect();
      return { name, client, ok: true, tools: client.tools };
    } catch (e) {
      client.stop();
      return { name, client: null, ok: false, error: e.message, tools: [] };
    }
  }));
  return results;
}
