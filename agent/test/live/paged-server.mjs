// Minimal official-SDK stdio server whose tools/list is paginated
// (7 tools, 3 per page, honors cursor) — a real implementation of the cursor
// contract the client follows. Used by http.mjs.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = Array.from({ length: 7 }, (_, i) => ({
  name: `tool_${i}`,
  description: `paginated tool ${i}`,
  inputSchema: { type: 'object', properties: {} },
}));
const PAGE = 3;

const server = new Server({ name: 'paged-sdk', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = req.params?.cursor ? Number(req.params.cursor) : 0;
  const slice = TOOLS.slice(start, start + PAGE);
  const next = start + PAGE;
  return next < TOOLS.length ? { tools: slice, nextCursor: String(next) } : { tools: slice };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `called ${req.params.name}` }],
}));

await server.connect(new StdioServerTransport());
