// Stub OpenAI-compatible server for process-level E2E verification.
// NOT a node --test file: run it standalone, point cowcat at it via
//   COWCAT_BASE_URL=http://127.0.0.1:<port> COWCAT_API_KEY=stub COWCAT_MODEL=openai/stub-model
// Behavior:
//   request #1 -> SSE: reasoning_content deltas, then one Bash tool_call
//                 (arguments split across chunks), finish_reason=tool_calls
//   request #2 -> SSE: final text answer echoing the tool output
// Every request body is appended as JSON to <COWCAT_STUB_LOG> (default
// ./stub-requests.jsonl) for post-run assertions.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.COWCAT_STUB_PORT || 8377);
const LOG = process.env.COWCAT_STUB_LOG || new URL('./stub-requests.jsonl', import.meta.url).pathname;
let n = 0;

const sse = (res, chunks) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};

const chunk = (delta, finish = null, usage = null) => ({
  id: 'chatcmpl-stub',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

const server = createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('nope');
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    n++;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* keep raw */ }
    appendFileSync(LOG, JSON.stringify({ n, body: parsed ?? body }) + '\n');
    const stream = parsed?.stream !== false;
    if (!stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'stub', choices: [{ message: { role: 'assistant', content: 'non-stream stub' } }] })); return; }
    if (n === 1) {
      sse(res, [
        chunk({ role: 'assistant', reasoning_content: '先' }),
        chunk({ reasoning_content: '思考' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_stub1', type: 'function', function: { name: 'Bash', arguments: '{"command":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ' "echo hi"}' } }] }),
        chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      ]);
    } else {
      const toolMsg = (parsed?.messages || []).filter((m) => m.role === 'tool').pop();
      const out = toolMsg?.content ?? '<no tool result>';
      sse(res, [
        chunk({ role: 'assistant', content: `工具输出: ${out}` }),
        chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }),
      ]);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(LOG, ''); // truncate per start
  console.log(`stub-openai-server on http://127.0.0.1:${PORT}`);
});
