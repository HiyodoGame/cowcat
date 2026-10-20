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
];

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
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake', version: '1.0.0' } },
    });
    return;
  }

  if (method === 'initialize') {
    result(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' },
    });
    return;
  }

  if (method === 'tools/list') {
    result(id, { tools });
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
    failure(id, -32602, `Unknown tool: ${String(name)}`);
    return;
  }

  if (method === 'notifications/cancelled' || method === 'notifications/initialized') {
    return;
  }

  failure(id, -32601, `Method not found: ${method}`);
});
