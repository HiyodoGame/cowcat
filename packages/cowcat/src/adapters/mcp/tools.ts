// MCP tools as `ToolPort`s (ADR-084).
//
// The server owns the schema and validates the arguments; this layer owns the name and
// the risk level. `exec` is deliberate: an MCP server can do anything its process can,
// and labelling it `read` would let the existing reads-are-free baseline wave it through.

import type { ToolPort } from '../../ports/index.js';
import type { McpClient, McpToolDefinition } from './client.js';

export const MCP_TOOL_PREFIX = 'mcp__';

/** `mcp__<server>__<tool>` — the shape Claude Code uses (ADR-084 ②). */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

export function createMcpTools(server: string, tools: readonly McpToolDefinition[], client: McpClient): readonly ToolPort[] {
  return tools.map((tool) => {
    const description = tool.description === '' ? `MCP tool ${tool.name}` : tool.description;
    return {
      spec: {
        name: mcpToolName(server, tool.name),
        description: `${description}\n\n(from the MCP server "${server}"; arguments are validated by the server)`,
        risk: 'exec',
        inputSchema: tool.inputSchema,
      },
      run: (input, signal) => client.callTool(tool.name, input, signal),
    };
  });
}
