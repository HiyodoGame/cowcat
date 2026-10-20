// Starting MCP servers and keeping their tools together (ADR-084/087/088).
//
// One server failing must not take the host down: a clone with a broken MCP entry is a
// normal condition, and the user needs the reason rather than a stack trace. Every
// failure therefore becomes a status plus a warning, and the remaining servers still
// work. Conflicts are the one case that must refuse the *server* rather than rename its
// tools: history and saved rules refer to tool names.
//
// The table is LIVE: `notifications/tools/list_changed` replaces exactly the tools a
// server owns, and the next turn reads the same Map. A refresh that collides with
// another server's tool skips that tool and says so; it does not kill a server that was
// working a moment ago.

import type { ProcessPort, SandboxProfile, ToolPort } from '../../ports/index.js';
import { McpClient, type McpToolDefinition } from './client.js';
import { createMcpTools, mcpToolName } from './tools.js';

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpServerStatus {
  readonly name: string;
  readonly connected: boolean;
  readonly toolCount: number;
  readonly era: string | null;
  readonly error: string | null;
  readonly warnings: readonly string[];
}

export interface McpServers {
  /** Built-ins plus every connected server's tools. Mutated on tool-list changes. */
  readonly table: ReadonlyMap<string, ToolPort>;
  readonly statuses: readonly McpServerStatus[];
  close(): Promise<void>;
}

export interface StartMcpServersOptions {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly cwd: string;
  /** The host's environment: inherited by every server, then redacted by the gateway. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sandbox: SandboxProfile;
  readonly process: ProcessPort;
  readonly version: string;
  /** The built-in tools. A server cannot silently shadow one. */
  readonly baseTools: ReadonlyMap<string, ToolPort>;
  /** Non-fatal findings, in the same channel config warnings use. */
  readonly warn: (message: string) => void;
  /** Host lifetime: aborting it terminates every server. */
  readonly signal: AbortSignal;
}

interface ServerRecord {
  readonly name: string;
  readonly client: McpClient;
  names: Set<string>;
  refreshing: boolean;
  refreshQueued: boolean;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

export async function startMcpServers(options: StartMcpServersOptions): Promise<McpServers> {
  const clients: McpClient[] = [];
  const statuses: McpServerStatus[] = [];
  const table = new Map<string, ToolPort>(options.baseTools);
  const inherited = Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined);

  async function refresh(record: ServerRecord): Promise<void> {
    if (record.refreshing) {
      record.refreshQueued = true;
      return;
    }
    record.refreshQueued = false;
    record.refreshing = true;
    try {
      const listed = await record.client.listTools();
      const accepted: ToolPort[] = [];
      const nextNames = new Set<string>();
      for (const tool of createMcpTools(record.name, listed.tools, record.client)) {
        if (table.has(tool.spec.name) && !record.names.has(tool.spec.name)) {
          options.warn(`mcp server "${record.name}": tool "${tool.spec.name}" collides with another tool; it was skipped`);
          continue;
        }
        accepted.push(tool);
        nextNames.add(tool.spec.name);
      }
      for (const old of record.names) {
        if (!nextNames.has(old)) table.delete(old);
      }
      for (const tool of accepted) table.set(tool.spec.name, tool);
      record.names = nextNames;
      replaceStatus(statuses, {
        name: record.name,
        connected: true,
        toolCount: accepted.length,
        era: record.client.era,
        error: null,
        warnings: listed.warnings,
      });
      for (const warning of listed.warnings) options.warn(`mcp server "${record.name}": ${warning}`);
    } catch (error) {
      // Keep the old tools: a failed refresh is not evidence the old list is wrong.
      options.warn(`mcp server "${record.name}": refreshing tools failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      record.refreshing = false;
      if (isRefreshQueued(record)) {
        record.refreshQueued = false;
        void refresh(record);
      }
    }
  }

  for (const [name, config] of Object.entries(options.servers)) {
    if (!SERVER_NAME.test(name)) {
      const problem = `invalid server name "${name}": use letters, digits, "_" or "-"`;
      statuses.push({ name, connected: false, toolCount: 0, era: null, error: problem, warnings: [] });
      options.warn(`mcp: ${problem} (the server was not started)`);
      continue;
    }

    let client: McpClient | null = null;
    try {
      const handle = await options.process.open(
        {
          argv: [config.command, ...(config.args ?? [])],
          cwd: options.cwd,
          // Inherited environment first, then the server's own entries. The gateway
          // redacts whichever of these are credential-shaped (ADR-015/085).
          env: { ...Object.fromEntries(inherited), ...config.env },
          sandbox: options.sandbox,
        },
        options.signal,
      );
      client = new McpClient(handle, { clientVersion: options.version });
      await client.start();
      const listed = await client.listTools();
      const collision = findCollision(listed.tools, name, table);
      if (collision !== null) {
        throw new Error(collision);
      }
      const built = createMcpTools(name, listed.tools, client);
      for (const tool of built) table.set(tool.spec.name, tool);
      const record: ServerRecord = {
        name,
        client,
        names: new Set(built.map((tool) => tool.spec.name)),
        refreshing: false,
        refreshQueued: false,
      };
      clients.push(client);

      const warnings = [...listed.warnings];
      const watchWarning = await client.watchTools();
      if (watchWarning !== null) warnings.push(watchWarning);
      statuses.push({ name, connected: true, toolCount: built.length, era: client.era, error: null, warnings });
      for (const warning of warnings) options.warn(`mcp server "${name}": ${warning}`);

      // The listener outlives this function; the client owns the subscription and the
      // host closes it with the process.
      client.onToolsChanged(() => {
        void refresh(record);
      });
    } catch (error) {
      // A started process that cannot be used is closed here; a failed start has none.
      if (client !== null) await client.close();
      const problem = error instanceof Error ? error.message : String(error);
      statuses.push({ name, connected: false, toolCount: 0, era: null, error: problem, warnings: [] });
      options.warn(`mcp server "${name}" was skipped: ${problem}`);
    }
  }

  return {
    table,
    statuses,
    async close(): Promise<void> {
      await Promise.all(clients.map((client) => client.close()));
      statuses.length = 0;
      table.clear();
    },
  };
}

function isRefreshQueued(record: ServerRecord): boolean {
  return record.refreshQueued;
}

function replaceStatus(statuses: McpServerStatus[], next: McpServerStatus): void {
  const index = statuses.findIndex((status) => status.name === next.name);
  if (index >= 0) statuses[index] = next;
  else statuses.push(next);
}

function findCollision(tools: readonly McpToolDefinition[], server: string, table: ReadonlyMap<string, ToolPort>): string | null {
  for (const tool of tools) {
    const name = mcpToolName(server, tool.name);
    if (table.has(name)) {
      return `tool "${name}" collides with an existing tool; the server was not started`;
    }
  }
  return null;
}
