// P0 wave 1: wiring fixes (todo sessionId via real CLI path, Agent model
// passthrough, grep params), WebFetch/WebSearch, openai countTokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { GrepTool } from '../src/tools/grep.js';
import { WebFetchTool } from '../src/tools/webfetch.js';
import { WebSearchTool, parseDuckDuckGoResults } from '../src/tools/websearch.js';
import { OpenAIProvider } from '../src/llm/openai.js';
import { estimateTokensLocal } from '../src/llm/tokapprox.js';
import { createSubagentRunner } from '../src/subagent.js';
import { compactConversation } from '../src/prompts/compact.js';
import { MockProvider, text } from './mock-provider.js';
import { MockUI } from '../src/ui.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { BashTool } from '../src/tools/bash.js';
import { GlobTool } from '../src/tools/glob.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeCtx(cwd, over = {}) {
  return { cwd, readSet: new Set(), state: {}, sessionId: 's', ui: new MockUI(), ...over };
}

// --- P0-1.1 todo sessionId through the real CLI path ------------------------

test('P0-1: TodoWrite persists under the real session id (not undefined.json)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"todos":[{"content":"Do x","status":"in_progress","activeForm":"Doing x"}]}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ trustedProjects: [cwd] }));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs')], {
      env: {
        ...process.env,
        COWCAT_HOME: home,
        COWCAT_PROVIDER: 'anthropic',
        COWCAT_BASE_URL: `http://127.0.0.1:${port}`,
        COWCAT_API_KEY: 'k',
        COWCAT_MODEL: 'm',
        COWCAT_ANIMATION: 'off',
      },
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const done = new Promise((resolve) => child.on('close', resolve));
    child.stdin.write('make a todo\n/exit\n');
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 15000);
    await done;
    clearTimeout(timer);
    const m = out.match(/session: .*[\\/]([^\\/]+)\.jsonl/);
    assert.ok(m, `session line not found in:\n${out}`);
    const sessionId = m[1];
    const todoFile = join(home, 'todos', `${sessionId}.json`);
    assert.ok(existsSync(todoFile), `todo file must be todos/<sessionId>.json (looked for ${todoFile})`);
    assert.ok(!existsSync(join(home, 'todos', 'undefined.json')), 'no undefined.json');
    const saved = JSON.parse(readFileSync(todoFile, 'utf8'));
    assert.equal(saved[0].content, 'Do x');
  } finally {
    server.close();
  }
});

test('P0-1: Agent tool model override reaches the provider call', async () => {
  const provider = new MockProvider([text('scout report')]);
  const registry = new ToolRegistry();
  for (const t of [ReadTool, GlobTool, GrepTool, BashTool]) registry.register(t);
  const runner = createSubagentRunner({ provider, registry, config: { maxTokens: 64, maxContextTokens: 10000 }, ui: new MockUI(), cwd: tmpdir() });
  await runner({ prompt: 'explore', model: 'custom-small-model' });
  assert.equal(provider.requests[0].model, 'custom-small-model');
});

test('P0-1: npm test script uses the glob form', () => {
  const pkg = JSON.parse(readFileSync(join(AGENT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
});

test('P0-1: compact summarizer honors smallModel override', async () => {
  const provider = new MockProvider([
    { respond: () => ({ content: [{ type: 'text', text: '<analysis>a</analysis>\n<summary>S</summary>' }] }) },
  ]);
  await compactConversation({ provider, messages: [{ role: 'user', content: 'hi' }], model: 'haiku-ish' });
  assert.equal(provider.requests[0].model, 'haiku-ish');
});

// --- P0-1.5 grep params ------------------------------------------------------

test('P0-1: grep -B/-A directional context and type filter', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-grep-'));
  writeFileSync(join(cwd, 'a.js'), 'l1\nl2\nMATCH\nl4\nl5\nl6\n');
  writeFileSync(join(cwd, 'b.py'), 'MATCH\n');
  const ctx = makeCtx(cwd);

  const ba = GrepTool.execute({ pattern: 'MATCH', path: cwd, output_mode: 'content', '-B': 2, '-A': 1, type: 'js' }, ctx);
  assert.ok(ba.ok);
  assert.match(ba.output, /l1/); // 2 lines before
  assert.match(ba.output, /l4/); // 1 after
  assert.ok(!ba.output.includes('b.py'), 'type filter excludes other languages');
  assert.match(ba.output, /1 file/);

  const bad = GrepTool.execute({ pattern: 'x', type: 'cobol' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown type/);
});

test('P0-1: grep multiline spans lines with dotall', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-grep-'));
  writeFileSync(join(cwd, 'x.txt'), 'start\nfunction f() {\n  body;\n}\nend\n');
  const ctx = makeCtx(cwd);
  const res = GrepTool.execute({ pattern: 'function[\\s\\S]*?}', path: cwd, output_mode: 'content', multiline: true }, ctx);
  assert.ok(res.ok);
  assert.match(res.output, /2:function f\(\) \{/);
  assert.match(res.output, /body;/);
});

// --- P0-2 web tools -----------------------------------------------------------

const HTML = `<html><head><style>.x{}</style><title>Doc</title></head><body>
<h1>Guide</h1>
<script>var evil = 1;</script>
<p>Hello <b>world</b> docs.</p>
<ul><li>First</li><li>Second</li></ul>
<a href="https://example.com/deep">deep link</a>
</body></html>`;

test('P0-1: Glob resolves a relative `path` against ctx.cwd (regression — resolve was never imported)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-glob-'));
  mkdirSync(join(cwd, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(cwd, 'sub', 'deep', 'a.js'), 'x');
  writeFileSync(join(cwd, 'top.md'), 'y');
  // before the fix `resolve` was undefined here and the tool threw a
  // ReferenceError instead of returning a result
  const rel = GlobTool.execute({ pattern: '**/*.js', path: 'sub' }, { cwd });
  assert.equal(rel.ok, true, rel.error);
  assert.match(rel.output, /a\.js/);
  assert.ok(!rel.output.includes('top.md'), 'scoped to the given path');
  // absolute paths and the default (ctx.cwd) keep working
  const abs = GlobTool.execute({ pattern: '*.js', path: join(cwd, 'sub', 'deep') }, { cwd });
  assert.equal(abs.ok, true, abs.error);
  assert.match(abs.output, /a\.js/);
  const def = GlobTool.execute({ pattern: '*.md' }, { cwd });
  assert.equal(def.ok, true);
  assert.match(def.output, /top\.md/);
  // a missing directory is still a clean error, not a throw
  const bad = GlobTool.execute({ pattern: '*', path: 'nope' }, { cwd });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Directory not found/);
});

test('P0-2: WebFetch converts HTML to text (scripts stripped, structure kept)', async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: new Map([['content-type', 'text/html']]).get ? { get: (k) => (k === 'content-type' ? 'text/html' : null) } : {},
    arrayBuffer: async () => Buffer.from(HTML),
  });
  const res = await WebFetchTool.execute({ url: 'https://example.com/doc', prompt: 'extract the guide' }, makeCtx(tmpdir(), { fetch: mockFetch }));
  assert.ok(res.ok);
  assert.ok(!res.output.includes('evil'), 'script content stripped');
  assert.match(res.output, /# Guide/);
  assert.match(res.output, /- First/);
  assert.match(res.output, /- Second/);
  assert.match(res.output, /\[deep link\]\(https:\/\/example\.com\/deep\)/);
  assert.match(res.output, /extract the guide/);
});

test('P0-2: WebFetch rejects binary and reports HTTP errors clearly', async () => {
  const binFetch = async () => ({
    ok: true,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => Buffer.from('%PDF-1.4 binary \x00\x01'),
  });
  const bin = await WebFetchTool.execute({ url: 'https://x/f.pdf' }, makeCtx(tmpdir(), { fetch: binFetch }));
  assert.equal(bin.ok, false);
  assert.match(bin.error, /Binary content/);

  const errFetch = async () => ({ ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => Buffer.from('') });
  const err = await WebFetchTool.execute({ url: 'https://x/missing' }, makeCtx(tmpdir(), { fetch: errFetch }));
  assert.equal(err.ok, false);
  assert.match(err.error, /HTTP 404/);
});

test('P0-2: WebSearch domain filters, count cap, engine error', async () => {
  const results = [
    { title: 'A', url: 'https://docs.example.com/a', snippet: 'sa', published_date: null },
    { title: 'B', url: 'https://blog.spam.com/b', snippet: 'sb', published_date: null },
    { title: 'C', url: 'https://example.com/c', snippet: 'sc', published_date: null },
  ];
  const engine = async () => results;
  const cwd = tmpdir();
  const allowed = await WebSearchTool.execute({ query: 'q', allowed_domains: ['example.com'], count: 10 }, makeCtx(cwd, { searchEngine: engine }));
  assert.match(allowed.output, /docs\.example\.com\/a/);
  assert.match(allowed.output, /example\.com\/c/);
  assert.ok(!allowed.output.includes('spam.com'));

  const blocked = await WebSearchTool.execute({ query: 'q', blocked_domains: ['spam.com'] }, makeCtx(cwd, { searchEngine: engine }));
  assert.ok(!blocked.output.includes('spam.com'));

  const capped = await WebSearchTool.execute({ query: 'q', count: 2 }, makeCtx(cwd, { searchEngine: engine }));
  assert.match(capped.output, /1\. A/);
  assert.match(capped.output, /2\. B/);
  assert.ok(!capped.output.includes('3. C'));

  const failing = await WebSearchTool.execute({ query: 'q' }, makeCtx(cwd, { searchEngine: async () => { throw new Error('network down'); } }));
  assert.equal(failing.ok, false);
  assert.match(failing.error, /network down/);
});

test('P0-2: DuckDuckGo HTML parser unwraps uddg redirect links', () => {
  const html = `
    <a class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Freal.example.com%2Fpage">Real &amp; Title</a>
    <a class="result__snippet" href="x">Some <b>snippet</b> text</a>
    <a class="result__a" href="https://direct.example.com/x">Direct</a>
    <a class="result__snippet" href="y">Direct snippet</a>`;
  const parsed = parseDuckDuckGoResults(html);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, 'https://real.example.com/page');
  assert.equal(parsed[0].title, 'Real & Title');
  assert.equal(parsed[0].snippet, 'Some snippet text');
  assert.equal(parsed[1].url, 'https://direct.example.com/x');
});

// --- P0-7 openai countTokens --------------------------------------------------

test('P0-7: local tokenizer returns plausible magnitudes for en/zh/code', () => {
  const en = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
  const zh = '这堵墙本来就该这么砌，它只是把工程提前了一天。'.repeat(15);
  const code = Array.from({ length: 30 }, (_, i) => `function add${i}(a, b) { return a + b; } // comment ${i}`).join('\n');
  const enT = estimateTokensLocal(en);
  const zhT = estimateTokensLocal(zh);
  const codeT = estimateTokensLocal(code);
  assert.ok(enT >= 150 && enT <= 300, `english ~1 token/4 chars: ${enT}`);
  assert.ok(zhT >= 250 && zhT <= 450, `chinese ~1 token/char: ${zhT}`);
  assert.ok(codeT >= 400 && codeT <= 800, `code: ${codeT}`);
  // calibration: est should track a chars/4 baseline within ~±20% for english
  const baseline = Math.ceil(en.length / 4);
  assert.ok(Math.abs(enT - baseline) / baseline < 0.2, `en est ${enT} vs chars/4 ${baseline}`);
});

test('P0-7: OpenAI provider.countTokens is local and sane', async () => {
  const provider = new OpenAIProvider({ model: 'm', apiKey: 'k', baseURL: 'http://127.0.0.1:1', maxTokens: 100 });
  const n = await provider.countTokens({ system: 'sys', messages: [{ role: 'user', content: 'hello world' }] });
  assert.equal(typeof n, 'number');
  assert.ok(n >= 1 && n < 1000);
});

// --- P0-3 descriptions stay intact & expanded ---------------------------------

test('P0-3: priority tool descriptions expanded, schemas unchanged', () => {
  const reg = new ToolRegistry();
  for (const t of [ReadTool, EditTool, WriteTool, BashTool, GlobTool, GrepTool]) reg.register(t);
  for (const name of ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']) {
    const tool = reg.get(name);
    assert.ok(tool.description.length >= 400, `${name} description too short (${tool.description.length})`);
    const v = reg.validate(name, {});
    assert.ok(!v.ok, `${name} schema should still require its args`);
  }
});
