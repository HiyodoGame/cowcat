// McpClient — the protocol half of MCP over stdio (ADR-083/087).
//
// It owns framing and correlation, not the process: the `ProcessHandle` comes from
// `ProcessPort.open()`, so sandbox, env redaction and termination stay in the gateway
// (ADR-086). What lives here is the part that is genuinely MCP's: dual-era detection,
// `_meta` on every modern request, and mapping results onto `ToolResult`.
//
// Two rules are load-bearing:
//   * No `initialize`-only client. A modern server rejects it (versioning matrix), so
//     the first request is `server/discover`; only a non-modern error or a timeout
//     falls back to the legacy handshake.
//   * No guessing at incomplete results. `input_required` is reported as unsupported
//     rather than retried with invented input.

import type { ProcessExit, ProcessHandle, ToolResult, Truncation } from '../../ports/index.js';

/** The modern revision this build speaks. */
export const MCP_MODERN_VERSION = '2026-07-28';
/** The last initialize-handshake revision, used only after the probe fails. */
export const MCP_LEGACY_VERSION = '2025-11-25';

const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 2_000;
const RESULT_CAP_CHARS = 20_000;

const MODERN_PROTOCOL = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

export type McpEra = 'modern' | 'legacy';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpToolList {
  readonly tools: readonly McpToolDefinition[];
  /** Non-fatal protocol findings, for the server status line (ADR-084 ⑤). */
  readonly warnings: readonly string[];
}

export class McpClientError extends Error {
  readonly kind: 'rpc' | 'protocol' | 'exited' | 'cancelled' | 'timeout' | 'unsupported-version';
  readonly rpcCode: number | null;
  readonly data: unknown;

  constructor(kind: McpClientError['kind'], message: string, options: { readonly rpcCode?: number; readonly data?: unknown } = {}) {
    super(message);
    this.name = 'McpClientError';
    this.kind = kind;
    this.rpcCode = options.rpcCode ?? null;
    this.data = options.data ?? null;
  }
}

export interface McpClientOptions {
  readonly clientVersion: string;
  readonly requestTimeoutMs?: number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  readonly #handle: ProcessHandle;
  readonly #options: McpClientOptions;
  readonly #pending = new Map<number, Pending>();
  readonly #exit: Promise<ProcessExit>;

  #era: McpEra = 'modern';
  #protocolVersion = MCP_MODERN_VERSION;
  #nextId = 1;
  #malformedLines = 0;
  #closed = false;
  #exited: ProcessExit | null = null;
  #terminated = false;
  #unsubscribeLine: (() => void) | null = null;
  #unsubscribeExit: (() => void) | null = null;
  #resolveExit: ((exit: ProcessExit) => void) | null = null;

  constructor(handle: ProcessHandle, options: McpClientOptions) {
    this.#handle = handle;
    this.#options = options;
    this.#exit = new Promise<ProcessExit>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#unsubscribeLine = handle.onStdoutLine((line) => {
      this.#onLine(line);
    });
    this.#unsubscribeExit = handle.onExit((exit) => {
      this.#onExit(exit);
    });
  }

  get era(): McpEra {
    return this.#era;
  }

  get protocolVersion(): string {
    return this.#protocolVersion;
  }

  /** Non-JSON stdout lines seen so far. Reported with the tool result, never treated as data. */
  get malformedLines(): number {
    return this.#malformedLines;
  }

  /**
   * Detects the server's era and performs whatever handshake that era needs.
   * Throws when the server cannot be used at all; a server that merely lacks tools
   * still throws here, because a tool-less MCP server has nothing to contribute.
   */
  async start(): Promise<void> {
    try {
      const discovered = await this.#request('server/discover', {}, undefined, PROBE_TIMEOUT_MS);
      const record = requireRecord(discovered, 'server/discover result');
      this.#selectMode(readStrings(record['supportedVersions']));
      this.#assertToolsCapability(record['capabilities']);
      if (this.#era === 'legacy') await this.#initializeLegacy();
      return;
    } catch (error) {
      if (error instanceof McpClientError && error.rpcCode === -32022) {
        const supported = readSupportedVersions(error.data);
        this.#selectMode(supported);
        if (this.#era === 'legacy') await this.#initializeLegacy();
        return;
      }
      // Anything else — a legacy `-32601`, an implementation-defined code, or no answer
      // at all — is the specified signal to fall back to the initialize handshake.
      if (error instanceof McpClientError && (error.kind === 'rpc' || error.kind === 'timeout')) {
        await this.#initializeLegacy();
        return;
      }
      throw error;
    }
  }

  async listTools(): Promise<McpToolList> {
    const result = await this.#request('tools/list', {});
    const record = requireRecord(result, 'tools/list result');
    const raw = record['tools'];
    if (!Array.isArray(raw)) throw new McpClientError('protocol', 'tools/list result has no tools array');

    const tools: McpToolDefinition[] = [];
    const warnings: string[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) {
        warnings.push('a tool entry was not an object and was skipped');
        continue;
      }
      const name = entry['name'];
      const inputSchema = entry['inputSchema'];
      if (typeof name !== 'string' || name === '' || !isRecord(inputSchema)) {
        warnings.push(`a tool entry was skipped: ${typeof name === 'string' && name !== '' ? name : '(unnamed)'} has no usable inputSchema`);
        continue;
      }
      tools.push({
        name,
        description: typeof entry['description'] === 'string' ? entry['description'] : '',
        inputSchema,
      });
    }
    if (record['nextCursor'] !== undefined) {
      // Pagination is not implemented (ADR-087 ⑦). Saying so beats silently listing less.
      warnings.push('tools/list returned nextCursor; only the first page is available');
    }
    return { tools, warnings };
  }

  /**
   * Calls one tool. `signal` is the turn's signal: aborting sends the protocol
   * cancellation and then terminates the process (ADR-087 ③) — both layers, because a
   * server may ignore the notification.
   */
  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    let result: unknown;
    try {
      result = await this.#request('tools/call', { name, arguments: args ?? {} }, signal);
    } catch (error) {
      return { ok: false, output: describeCallFailure(error) };
    }
    return this.#toToolResult(result);
  }

  /** Close stdin, wait briefly, then terminate. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#handle.closeStdin();
    const exited = await Promise.race([
      this.#exit.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, CLOSE_GRACE_MS);
      }),
    ]);
    if (!exited) await this.#terminate('shutdown');
    this.#unsubscribeLine?.();
    this.#unsubscribeExit?.();
  }

  async #initializeLegacy(): Promise<void> {
    // Set the era first: every request built after this point must omit `_meta`.
    this.#era = 'legacy';
    this.#protocolVersion = MCP_LEGACY_VERSION;
    const result = await this.#request(
      'initialize',
      {
        protocolVersion: MCP_LEGACY_VERSION,
        capabilities: {},
        clientInfo: { name: 'cowcat', version: this.#options.clientVersion },
      },
      undefined,
      PROBE_TIMEOUT_MS,
    );
    const record = requireRecord(result, 'initialize result');
    this.#assertToolsCapability(record['capabilities']);
    this.#notify('notifications/initialized', {});
  }

  #selectMode(supported: readonly string[]): void {
    if (supported.includes(MCP_MODERN_VERSION)) {
      this.#era = 'modern';
      this.#protocolVersion = MCP_MODERN_VERSION;
      return;
    }
    if (supported.includes(MCP_LEGACY_VERSION)) {
      this.#era = 'legacy';
      this.#protocolVersion = MCP_LEGACY_VERSION;
      return;
    }
    throw new McpClientError('unsupported-version', `the MCP server supports no version this client speaks: ${supported.join(', ') || '(none advertised)'}`);
  }

  #assertToolsCapability(capabilities: unknown): void {
    const record = isRecord(capabilities) ? capabilities : null;
    if (record === null || !isRecord(record['tools'])) {
      throw new McpClientError('protocol', 'the MCP server does not declare the tools capability');
    }
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#malformedLines += 1;
      return;
    }
    if (!isRecord(message)) {
      this.#malformedLines += 1;
      return;
    }
    const id = message['id'];
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const error = message['error'];
    if (isRecord(error)) {
      const code = typeof error['code'] === 'number' ? error['code'] : 0;
      const text = typeof error['message'] === 'string' ? error['message'] : 'unknown MCP error';
      pending.reject(new McpClientError('rpc', `${text} (code ${String(code)})`, { rpcCode: code, data: error['data'] }));
      return;
    }
    pending.resolve(message['result']);
  }

  #onExit(exit: ProcessExit): void {
    this.#exited = exit;
    this.#resolveExit?.(exit);
    const detail = exit.stderr.trim() === '' ? '' : `: ${exit.stderr.trim().slice(-2_000)}`;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new McpClientError('exited', `MCP server exited (${formatExit(exit)})${detail}`));
    }
  }

  #decorate(params: Record<string, unknown>): Record<string, unknown> {
    if (this.#era === 'legacy') return params;
    return {
      ...params,
      _meta: {
        [MODERN_PROTOCOL]: this.#protocolVersion,
        [CLIENT_INFO]: { name: 'cowcat', version: this.#options.clientVersion },
        [CLIENT_CAPABILITIES]: {},
      },
    };
  }

  #request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new McpClientError('exited', 'the MCP client is closed'));
    if (this.#exited !== null) {
      return Promise.reject(new McpClientError('exited', `MCP server exited (${formatExit(this.#exited)}); no restart is attempted (ADR-087 ②)`));
    }
    if (signal?.aborted === true) return Promise.reject(new McpClientError('cancelled', 'the MCP request was cancelled before it was sent'));

    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#notify('notifications/cancelled', { requestId: id, reason: 'cancelled' });
        // The protocol notification is advisory; the process is the part we can prove.
        void this.#terminate('cancel');
        reject(new McpClientError('cancelled', `MCP request ${method} was cancelled`));
      };

      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        this.#notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new McpClientError('timeout', `MCP request ${method} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#handle.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: this.#decorate(params) }));
    });
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#handle.write(JSON.stringify({ jsonrpc: '2.0', method, params: this.#decorate(params) }));
  }

  async #terminate(reason: 'cancel' | 'shutdown'): Promise<void> {
    if (this.#terminated) return;
    this.#terminated = true;
    await this.#handle.terminate(reason);
  }

  #toToolResult(raw: unknown): ToolResult {
    const record = requireRecord(raw, 'tools/call result');
    const resultType = record['resultType'];
    if (resultType === 'input_required') {
      return {
        ok: false,
        output: 'the MCP server requested additional input (input_required), which this client does not support yet',
      };
    }
    if (resultType !== undefined && resultType !== 'complete') {
      const shown = typeof resultType === 'string' ? resultType : JSON.stringify(resultType);
      return { ok: false, output: `the MCP server returned an unsupported resultType: ${shown}` };
    }

    const pieces: string[] = [];
    let omitted = 0;
    const content = record['content'];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string') {
          pieces.push(item['text']);
        } else {
          omitted += 1;
        }
      }
    }
    if (record['structuredContent'] !== undefined) {
      pieces.push(JSON.stringify(record['structuredContent']));
    }
    if (omitted > 0) pieces.push(`(${String(omitted)} non-text content item${omitted === 1 ? '' : 's'} omitted: this client only handles text)`);
    if (this.#malformedLines > 0) pieces.push(`(${String(this.#malformedLines)} stdout line${this.#malformedLines === 1 ? '' : 's'} were not JSON and were ignored)`);
    if (pieces.length === 0) pieces.push('(the MCP server returned no content)');

    const clipped = clip(pieces.join('\n'));
    return {
      ok: record['isError'] !== true,
      output: clipped.output,
      ...(clipped.truncation === undefined ? {} : { truncation: clipped.truncation }),
    };
  }
}

function clip(text: string): { readonly output: string; readonly truncation?: Truncation } {
  if (text.length <= RESULT_CAP_CHARS) return { output: text };
  return {
    output: `${text.slice(0, RESULT_CAP_CHARS)}\n\n[truncated: ${String(text.length - RESULT_CAP_CHARS)} more characters]`,
    truncation: {
      truncated: true,
      dropped: text.length - RESULT_CAP_CHARS,
      reason: `mcp: ${String(RESULT_CAP_CHARS)} characters`,
    },
  };
}

function describeCallFailure(error: unknown): string {
  if (error instanceof McpClientError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function formatExit(exit: ProcessExit): string {
  if (exit.exitCode !== null) return `exit code ${String(exit.exitCode)}`;
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return 'no exit status';
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new McpClientError('protocol', `${what} is not a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readSupportedVersions(data: unknown): readonly string[] {
  if (!isRecord(data)) return [];
  return readStrings(data['supported']);
}
