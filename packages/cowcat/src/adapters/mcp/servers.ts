// Starting MCP servers and keeping their tools together (ADR-084/087).
//
// One server failing must not take the host down: a clone with a broken MCP entry is a
// normal condition, and the user needs the reason rather than a stack trace. Every
// failure therefore becomes a status plus a warning, and the remaining servers still
// work. Conflicts are the one case that must refuse the *server* rather than rename its
// tools: history and saved rules refer to tool names.

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
  readonly tools: readonly ToolPort[];
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
  /** Built-in tool names, so a server cannot silently shadow one. */
  readonly reserved: readonly string[];
  /** Non-fatal findings, in the same channel config warnings use. */
  readonly warn: (message: string) => void;
  /** Host lifetime: aborting it terminates every server. */
  readonly signal: AbortSignal;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

export async function startMcpServers(options: StartMcpServersOptions): Promise<McpServers> {
  const clients: McpClient[] = [];
  const tools: ToolPort[] = [];
  const statuses: McpServerStatus[] = [];
  const claimed = new Map<string, string>(options.reserved.map((name) => [name, 'built-in']));
  const inherited = Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined);

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
      const collision = findCollision(listed.tools, name, claimed);
      if (collision !== null) {
        throw new Error(collision);
      }
      for (const definition of listed.tools) {
        claimed.set(mcpToolName(name, definition.name), name);
      }
      const built = createMcpTools(name, listed.tools, client);
      tools.push(...built);
      clients.push(client);
      statuses.push({
        name,
        connected: true,
        toolCount: built.length,
        era: client.era,
        error: null,
        warnings: listed.warnings,
      });
      for (const warning of listed.warnings) options.warn(`mcp server "${name}": ${warning}`);
    } catch (error) {
      // A started process that cannot be used is closed here; a failed start has none.
      if (client !== null) await client.close();
      const problem = error instanceof Error ? error.message : String(error);
      statuses.push({ name, connected: false, toolCount: 0, era: null, error: problem, warnings: [] });
      options.warn(`mcp server "${name}" was skipped: ${problem}`);
    }
  }

  return {
    tools,
    statuses,
    async close(): Promise<void> {
      await Promise.all(clients.map((client) => client.close()));
      statuses.length = 0;
    },
  };
}

function findCollision(tools: readonly McpToolDefinition[], server: string, claimed: ReadonlyMap<string, string>): string | null {
  for (const tool of tools) {
    const name = mcpToolName(server, tool.name);
    const owner = claimed.get(name);
    if (owner !== undefined) {
      return `tool "${name}" collides with ${owner === 'built-in' ? 'a built-in tool' : `server "${owner}"`}; the server was not started`;
    }
  }
  return null;
}
