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

// --- config ------------------------------------------------------------------

export function loadMcpConfigs(cwd) {
  const servers = {};
  const read = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')).mcpServers || {}; } catch { return {}; }
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
  constructor(name, def) {
    this.name = name;
    this.def = def;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.child = spawn(this.def.command, this.def.args || [], {
        env: { ...process.env, ...(this.def.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const to = setTimeout(() => reject(new Error('connect timeout')), getTimeout());
      this.child.stdout.on('data', (chunk) => this._onData(chunk));
      this.child.stderr.on('data', () => {});
      this.child.on('error', (e) => { clearTimeout(to); reject(e); });
      this.child.on('exit', (code) => {
        for (const { reject: rj } of this.pending.values()) rj(new Error(`server exited (code ${code})`));
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
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${getTimeout() / 1000}s`));
      }, getTimeout());
      this.pending.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params) {
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* dead */ }
  }
  stop() {
    try { this.child?.kill(); } catch { /* noop */ }
  }
}

// --- http transport (POST JSON-RPC; parses SSE data lines or plain JSON) -------

class HttpTransport {
  constructor(name, def, fetchImpl = fetch) {
    this.name = name;
    this.def = def;
    this.fetch = fetchImpl;
    this.nextId = 1;
  }
  async connect() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cowcat', version: '0.5.0' },
    });
    await this.request('notifications/initialized', {}).catch(() => {});
    return {};
  }
  async request(method, params) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), getTimeout());
    try {
      const res = await this.fetch(this.def.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.def.headers || {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (text.includes('data:')) {
        const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
        const msg = JSON.parse(dataLine.slice(5).trim());
        if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
        return msg.result;
      }
      const msg = JSON.parse(text);
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    } finally {
      clearTimeout(to);
    }
  }
  stop() { /* stateless */ }
}

// --- client -------------------------------------------------------------------

export class McpClient {
  constructor(name, def, { fetchImpl } = {}) {
    this.name = name;
    this.def = def;
    this.transport = def.url
      ? new HttpTransport(name, def, fetchImpl)
      : new StdioTransport(name, def);
    this.tools = [];
  }
  async connect() {
    await this.transport.connect();
    const res = await this.transport.request('tools/list', {});
    this.tools = res.tools || [];
    return this;
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

export async function connectAll(servers, { fetchImpl } = {}) {
  const names = Object.keys(servers);
  const results = await Promise.all(names.map(async (name) => {
    const client = new McpClient(name, servers[name], { fetchImpl });
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
