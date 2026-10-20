// A deliberately small MCP server used by the offline tests (ADR-083~087).
//
// Modes:
//   modern  — answers `server/discover` with 2026-07-28
//   legacy  — answers `server/discover` with -32601 and expects `initialize`
//   crash   — exits before speaking
//
// Tools:
//   echo   — returns the `text` argument
//   fail   — returns `isError: true`
//   env    — returns the value of MCP_TEST_TOKEN (proves env redaction)
//   crash  — exits the process mid-call
//   hang   — never answers (for cancellation)

import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'modern';

if (mode === 'crash') {
  process.exit(3);
}

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const result = (id: number, body: Record<string, unknown>): void => {
  send({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...body } });
};

const failure = (id: number, code: number, message: string): void => {
  send({ jsonrpc: '2.0', id, error: { code, message } });
};

const tools = [
  {
    name: 'echo',
    description: 'Echo the text argument',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'fail',
    description: 'Always fail',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'env',
    description: 'Report MCP_TEST_TOKEN',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: 'Exit the server',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hang',
    description: 'Never answer',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'change',
    description: 'Add a tool and announce the change',
    inputSchema: { type: 'object', properties: {} },
  },
];

const currentTools = [...tools];
let subscriptionId: number | null = null;

const announceChange = (): void => {
  send({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
    params: subscriptionId === null ? {} : { _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId } },
  });
};

const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== 'object' || message === null) return;
  const record = message as Record<string, unknown>;
  const id = record['id'];
  const method = record['method'];
  if (typeof id !== 'number' || typeof method !== 'string') return;

  if (method === 'server/discover') {
    if (mode === 'legacy') {
      failure(id, -32601, 'Method not found');
      return;
    }
    result(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: true } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake', version: '1.0.0' } },
    });
    return;
  }

  if (method === 'initialize') {
    result(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fake', version: '1.0.0' },
    });
    return;
  }

  if (method === 'tools/list') {
    const params = typeof record['params'] === 'object' && record['params'] !== null ? (record['params'] as Record<string, unknown>) : {};
    if (mode === 'paginated') {
      if (params['cursor'] === undefined) {
        result(id, { tools: currentTools.slice(0, 2), nextCursor: 'page-2' });
      } else {
        result(id, { tools: currentTools.slice(2) });
      }
      return;
    }
    result(id, { tools: currentTools });
    return;
  }

  if (method === 'subscriptions/listen') {
    subscriptionId = id;
    send({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: { 'io.modelcontextprotocol/subscriptionId': id }, notifications: { toolsListChanged: true } },
    });
    return;
  }

  if (method === 'tools/call') {
    const params = typeof record['params'] === 'object' && record['params'] !== null ? (record['params'] as Record<string, unknown>) : {};
    const name = params['name'];
    const args = typeof params['arguments'] === 'object' && params['arguments'] !== null ? (params['arguments'] as Record<string, unknown>) : {};
    if (name === 'echo') {
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      result(id, { content: [{ type: 'text', text: `echo: ${text}` }] });
      return;
    }
    if (name === 'fail') {
      result(id, { content: [{ type: 'text', text: 'deliberate failure' }], isError: true });
      return;
    }
    if (name === 'env') {
      result(id, { content: [{ type: 'text', text: `token=${process.env['MCP_TEST_TOKEN'] ?? 'missing'}` }] });
      return;
    }
    if (name === 'crash') {
      process.exit(7);
    }
    if (name === 'hang') {
      return;
    }
    if (name === 'change') {
      if (!currentTools.some((tool) => tool.name === 'added')) {
        currentTools.push({
          name: 'added',
          description: 'Appeared after a change notification',
          inputSchema: { type: 'object', properties: {} },
        });
      }
      announceChange();
      result(id, { content: [{ type: 'text', text: 'changed' }] });
      return;
    }
    failure(id, -32602, `Unknown tool: ${String(name)}`);
    return;
  }

  if (method === 'notifications/cancelled' || method === 'notifications/initialized') {
    return;
  }

  failure(id, -32601, `Method not found: ${method}`);
});
