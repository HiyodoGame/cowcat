// End-to-end tests for the cowcat harness. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { GlobTool } from '../src/tools/glob.js';
import { GrepTool } from '../src/tools/grep.js';
import { BashTool } from '../src/tools/bash.js';
import { TodoWriteTool } from '../src/tools/todo.js';
import { AskUserQuestionTool } from '../src/tools/ask.js';
import { AgentTool } from '../src/tools/agent.js';
import { Permissions } from '../src/permissions.js';
import { MockUI } from '../src/ui.js';
import { runLoop } from '../src/loop.js';
import { Session } from '../src/session.js';
import { MockProvider, text, toolUse, sseEvent, sseData } from './mock-provider.js';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeRegistry() {
  const reg = new ToolRegistry();
  for (const t of [ReadTool, EditTool, WriteTool, GlobTool, GrepTool, BashTool, TodoWriteTool, AskUserQuestionTool, AgentTool]) {
    reg.register(t);
  }
  return reg;
}

function makeCtx(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-test-'));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home; // session/todo persistence targets the cowcat home dir
  return {
    cwd, home, readSet: new Set(), state: {}, sessionId: 'test-session',
    ui: new MockUI(), permissions: new Permissions('yolo'),
    config: { maxTokens: 1024, maxContextTokens: 100000 },
    ...over,
  };
}

const SYS = 'You are a test agent.';

async function run(script, { messages, ctx, permissions, ui, providerOpts } = {}) {
  const provider = new MockProvider(script, providerOpts);
  const registry = makeRegistry();
  const finalCtx = ctx || makeCtx();
  finalCtx.permissions = permissions || finalCtx.permissions;
  finalCtx.ui = ui || finalCtx.ui;
  const res = await runLoop({
    provider, registry, system: SYS, messages: messages || [], ctx: finalCtx,
    ui: finalCtx.ui, permissions: finalCtx.permissions, config: finalCtx.config,
  });
  return { ...res, provider, ctx: finalCtx };
}

test('a) plain text round-trip with mock provider', async () => {
  const { finalText, messages, provider } = await run([text('Hello from mock')], {
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(finalText, 'Hello from mock');
  assert.equal(messages.length, 2);
  assert.equal(provider.requests.length, 1);
  assert.match(provider.requests[0].system, /test agent/);
});

test('b) Read tool_use executes and tool_result is fed back with matching id', async () => {
  const pkgPath = join(AGENT_ROOT, 'package.json');
  const { finalText, messages } = await run([
    toolUse('tu_1', 'Read', { file_path: pkgPath }),
    text('The package name is cowcat.'),
  ], { messages: [{ role: 'user', content: 'read the package.json' }] });

  assert.match(finalText, /cowcat/);
  // message sequence: user, assistant(tool_use), user(tool_result), assistant(text)
  assert.equal(messages.length, 4);
  const [user0, asst1, user2, asst3] = messages;
  assert.equal(asst1.role, 'assistant');
  assert.equal(asst1.content[0].type, 'tool_use');
  assert.equal(asst1.content[0].id, 'tu_1');
  assert.equal(user2.role, 'user');
  assert.equal(user2.content[0].type, 'tool_result');
  assert.equal(user2.content[0].tool_use_id, 'tu_1');
  assert.ok(!user2.content[0].is_error);
  const raw = readFileSync(pkgPath, 'utf8');
  assert.ok(user2.content[0].content.includes(JSON.parse(raw).name));
  assert.equal(asst3.role, 'assistant');
});

test('c) Edit error paths: not-read-first and non-unique old_string are reported back', async () => {
  const ctx = makeCtx();
  const file = join(ctx.cwd, 'a.txt');
  writeFileSync(file, 'foo\nbar\nfoo\n');

  // 1. Edit without reading first -> error
  let res = await run([toolUse('tu_1', 'Edit', { file_path: file, old_string: 'bar', new_string: 'baz' }), text('done')], {
    messages: [{ role: 'user', content: 'edit' }], ctx,
  });
  let toolMsg = res.messages[2];
  assert.equal(toolMsg.content[0].is_error, true);
  assert.match(toolMsg.content[0].content, /not been read yet/);

  // 2. Edit with ambiguous old_string -> error; replace_all fixes it
  ctx.readSet.add(file);
  res = await run([
    {
      message: {
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file_path: file, old_string: 'foo', new_string: 'qux' } },
          { type: 'tool_use', id: 'tu_3', name: 'Edit', input: { file_path: file, old_string: 'foo', new_string: 'qux', replace_all: true } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('fixed'),
  ], { messages: [{ role: 'user', content: 'edit' }], ctx });
  const results = res.messages[2].content;
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content, /not unique/);
  assert.ok(!results[1].is_error, 'replace_all should succeed');
  assert.equal(readFileSync(file, 'utf8'), 'qux\nbar\nqux\n');
});

test('d) permissions: Write prompts in default mode, yolo skips asking', async () => {
  const messages = [{ role: 'user', content: 'write a file' }];

  // default mode: user approves with "y"
  let ui = new MockUI({ answers: ['y'] });
  let ctx = makeCtx();
  let res = await run([
    toolUse('tu_1', 'Write', { file_path: join(ctx.cwd, 'out.txt'), content: 'hello' }),
    text('written'),
  ], { messages: [...messages], ctx, ui, permissions: new Permissions('default') });
  assert.equal(res.ctx.ui.approvals.length, 1);
  assert.equal(res.ctx.ui.approvals[0].toolName, 'Write');
  assert.ok(existsSync(join(ctx.cwd, 'out.txt')));

  // yolo mode: no approval asked
  ui = new MockUI();
  ctx = makeCtx();
  res = await run([
    toolUse('tu_1', 'Write', { file_path: join(ctx.cwd, 'out.txt'), content: 'hello' }),
    text('written'),
  ], { messages: [...messages], ctx, ui, permissions: new Permissions('yolo') });
  assert.equal(res.ctx.ui.approvals.length, 0);
  assert.ok(existsSync(join(ctx.cwd, 'out.txt')));
});

test('e) auto-compact: count_tokens decides, summarizer uses one-line identity + Read-only tools', async () => {
  const ctx = makeCtx();
  ctx.config.maxContextTokens = 100;
  const longHistory = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(300) }] }, // est ~80 -> probe zone
    { role: 'user', content: 'more' },
  ];
  const script = [
    { respond: (req) => ({ content: [{ type: 'text', text: '<analysis>looked at everything</analysis>\n<summary>Summary of prior work.</summary>' }] }) },
    text('done after compact'),
  ];
  const provider = new MockProvider(script, { countTokens: 5000 }); // real count forces compact
  const registry = makeRegistry();
  const res = await runLoop({
    provider, registry, system: SYS, messages: longHistory, ctx,
    ui: ctx.ui, permissions: ctx.permissions, config: ctx.config,
  });
  assert.equal(provider.countTokensCalls.length, 1, 'count_tokens must be consulted');
  assert.equal(res.compacted, 1);
  assert.equal(res.finalText, 'done after compact');
  // P1-8: summarizer request shape
  const compactReq = provider.requests[0];
  assert.equal(compactReq.system, 'You are a helpful AI assistant tasked with summarizing conversations.');
  assert.deepEqual((compactReq.tools || []).map((t) => t.name), ['Read']);
  assert.equal(compactReq.temperature, 1);
  assert.equal(compactReq.maxTokens, 20000);
  assert.match(compactReq.messages[0].content, /<analysis>/, "compact instruction demands analysis first");
  // P1-8: resume wrapper = single rebuilt user message
  assert.equal(res.messages[0].role, 'user');
  assert.match(res.messages[0].content, /continued from a previous conversation/);
  assert.match(res.messages[0].content, /Summary of prior work/);
  assert.match(res.messages[0].content, /without asking the user any further questions/);
});

test('e2) count_tokens fallback: endpoint error falls back to local estimate', async () => {
  const ctx = makeCtx();
  ctx.config.maxContextTokens = 100;
  const history = [
    { role: 'user', content: 'y'.repeat(500) }, // est ~125 > threshold
  ];
  const provider = new MockProvider([text('fine'), text('recovered')], { countTokens: 'error' });
  const res = await runLoop({
    provider, registry: makeRegistry(), system: SYS, messages: history, ctx,
    ui: ctx.ui, permissions: ctx.permissions, config: ctx.config,
  });
  assert.equal(provider.countTokensCalls.length, 1);
  assert.equal(res.compacted, 1, 'local estimate must decide when count_tokens fails');
  assert.match(res.finalText, /recovered/);
});

test('e3) real count below threshold prevents compact; big tool_result triggers the probe', async () => {
  const ctx = makeCtx();
  ctx.config.maxContextTokens = 100;
  const history = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(300) }] }, // est ~80 -> probe, real 50 -> no compact
  ];
  const provider = new MockProvider([text('no compact needed')], { countTokens: 50 });
  const res = await runLoop({
    provider, registry: makeRegistry(), system: SYS, messages: history, ctx,
    ui: ctx.ui, permissions: ctx.permissions, config: ctx.config,
  });
  assert.equal(res.compacted, 0);
  assert.equal(provider.countTokensCalls.length, 1);

  // big tool_result (>8000 chars) probes count_tokens even with small estimate
  const ctx2 = makeCtx();
  ctx2.config.maxContextTokens = 100000;
  const big = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/big' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'line\n'.repeat(5000) }] },
  ];
  const provider2 = new MockProvider([text('small context')], { countTokens: 42 });
  const res2 = await runLoop({
    provider: provider2, registry: makeRegistry(), system: SYS, messages: big, ctx: ctx2,
    ui: ctx2.ui, permissions: ctx2.permissions, config: ctx2.config,
  });
  assert.equal(provider2.countTokensCalls.length, 1, 'big tool_result must trigger the probe');
  assert.equal(res2.compacted, 0);
});

test('f) anthropic and openai stream parsers produce equivalent internal messages', async () => {
  const anthropicEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check. ' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' "/tmp/x"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  const openAIChunks = [
    { choices: [{ delta: { role: 'assistant', content: 'Let me check. ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'toolu_1', function: { name: 'Read', arguments: '{"file_path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' "/tmp/x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 12 } },
  ];

  const viaAnthropic = await run([{ sseAnthropic: anthropicEvents }, text('ok')], { messages: [{ role: 'user', content: 'go' }] });
  const viaOpenAI = await run([{ sseOpenAI: openAIChunks }, text('ok')], { messages: [{ role: 'user', content: 'go' }] });

  const strip = (msgs) => msgs.map((m) => ({ role: m.role, content: m.content }));
  const a = JSON.parse(JSON.stringify(strip(viaAnthropic.messages)));
  const b = JSON.parse(JSON.stringify(strip(viaOpenAI.messages)));
  // Normalize tool_use id (openai parser may synthesize ids) and usage noise for comparison.
  for (const set of [a, b]) {
    for (const m of set) {
      for (const blk of m.content || []) {
        if (blk.type === 'tool_use') delete blk.id;
      }
    }
  }
  assert.deepEqual(a, b);
});

test('g) TodoWrite persists under the cowcat home dir and injects reminder', async () => {
  const ctx = makeCtx();
  const { messages } = await run([
    toolUse('tu_1', 'TodoWrite', { todos: [{ content: 'Do thing', status: 'in_progress', activeForm: 'Doing thing' }] }),
    text('tracked'),
  ], { messages: [{ role: 'user', content: 'track it' }], ctx });
  const todoFile = join(ctx.home, 'todos', 'test-session.json');
  assert.ok(existsSync(todoFile));
  const saved = JSON.parse(readFileSync(todoFile, 'utf8'));
  assert.equal(saved[0].content, 'Do thing');
  // The second provider request should carry the todo reminder.
  assert.match(JSON.stringify(messages), /Do thing/);
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});

test('i) reminder injection never drops tool_result from the follow-up request', async () => {
  const pkgPath = join(AGENT_ROOT, 'package.json');
  const { provider } = await run([
    toolUse('tu_9', 'Read', { file_path: pkgPath }),
    text('ok'),
  ], { messages: [{ role: 'user', content: 'go' }] });
  assert.equal(provider.requests.length, 2);
  const lastMsg = provider.requests[1].messages[provider.requests[1].messages.length - 1];
  const blocks = lastMsg.content;
  const trs = blocks.filter((b) => b.type === 'tool_result');
  assert.equal(trs.length, 1);
  assert.equal(trs[0].tool_use_id, 'tu_9');
  // tool_result messages must LEAD with tool_result blocks (Kimi pairing):
  // the reminder text block rides at the end.
  assert.equal(blocks[0].type, 'tool_result');
  const reminderBlocks = blocks.filter((b) => b.type === 'text' && /system-reminder/.test(b.text));
  assert.equal(reminderBlocks.length, 1, 'reminder still injected after results');
});

test('P1-6) reminder precedes user text and the cache breakpoint lands on user text', async () => {
  const { buildAnthropicRequestBody } = await import('../src/llm/anthropic.js');
  const { provider } = await run([text('ok')], { messages: [{ role: 'user', content: 'original user words' }] });
  const lastMsg = provider.requests[0].messages[provider.requests[0].messages.length - 1];
  assert.ok(Array.isArray(lastMsg.content), 'reminder + user text become separate blocks');
  assert.match(lastMsg.content[0].text, /system-reminder/);
  assert.equal(lastMsg.content[1].text, 'original user words');
  // the wire breakpoint must sit on the user text (tail block), not the reminder
  const body = buildAnthropicRequestBody({ model: 'm', maxTokens: 100, cache: true }, {
    system: ['env', 'main'], messages: [lastMsg], tools: [], stream: true,
  });
  const tail = body.messages[0].content[1];
  assert.equal(tail.text, 'original user words');
  assert.deepEqual(tail.cache_control, { type: 'ephemeral' });
  assert.equal(body.messages[0].content[0].cache_control, undefined, 'reminder must not carry the breakpoint');
});

test('P1-7) subagent runs read-only with its own system prompt and isolated context', async () => {
  const { createSubagentRunner, SUBAGENT_TOOLS } = await import('../src/subagent.js');
  const { EXPLORE_SYSTEM_PROMPT } = await import('../src/prompts/subagents.js');
  const ctx = makeCtx();
  const registry = makeRegistry();
  // subagent tries to write -> plan-mode rejection; then reports back
  const subProvider = new MockProvider([
    toolUse('s1', 'Write', { file_path: join(ctx.cwd, 'evil.txt'), content: 'x' }),
    text('scout report: 2 files found'),
  ], { countTokens: 10 });
  const runner = createSubagentRunner({ provider: subProvider, registry, config: ctx.config, ui: ctx.ui, cwd: ctx.cwd });
  const mainMessages = [{ role: 'user', content: 'explore' }];
  const report = await runner({ prompt: 'find stuff', maxTurns: 5 });
  assert.match(report, /scout report/);
  // read-only: the sub-loop Write was rejected and no file was created
  assert.ok(!existsSync(join(ctx.cwd, 'evil.txt')));
  assert.deepEqual(SUBAGENT_TOOLS, ['Read', 'Glob', 'Grep', 'Bash']);
  const subReq = subProvider.requests[0];
  assert.equal(subReq.system, EXPLORE_SYSTEM_PROMPT);
  assert.deepEqual(subReq.tools.map((t) => t.name).sort(), ['Bash', 'Glob', 'Grep', 'Read']);
  const subResults = subProvider.requests[1].messages.flatMap((m) => m.content || [])
    .filter((b) => b.type === 'tool_result' && b.is_error);
  assert.ok(subResults.some((b) => /plan mode/i.test(b.content)), 'write attempt rejected in sub-loop');
  assert.equal(mainMessages.length, 1, 'main context untouched by the sub-loop');
});

test('P1-7b) Agent tool returns the subagent report to the main loop', async () => {
  const ctx = makeCtx();
  let subPrompt = null;
  ctx.spawnAgent = async ({ prompt }) => { subPrompt = prompt; return 'REPORT-BODY'; };
  const res = await run([
    toolUse('a1', 'Agent', { description: 'scan codebase', prompt: 'find entrypoints' }),
    text('main continues'),
  ], { messages: [{ role: 'user', content: 'delegate' }], ctx });
  assert.equal(subPrompt, 'find entrypoints');
  assert.match(res.messages[2].content[0].content, /REPORT-BODY/);
  assert.match(res.finalText, /main continues/);
});

test('P1-8) large-file reminders injected for dropped big reads (char fallback)', async () => {
  const { compactConversation } = await import('../src/prompts/compact.js');
  const bigPath = '/repo/src/big.js';
  const messages = [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: bigPath } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x\n'.repeat(12000) }] }, // ~24k chars
  ];
  const provider = new MockProvider([
    { respond: () => ({ content: [{ type: 'text', text: '<analysis>a</analysis>\n<summary>S</summary>' }] }) },
  ]);
  const { messages: rebuilt, boundarySummary, compactedCount, keptRecent } = await compactConversation({ provider, messages, sessionFile: '/home/u/sess.jsonl' });
  assert.equal(compactedCount, 3, 'all three messages summarized in full mode');
  assert.equal(keptRecent, 0);
  assert.equal(rebuilt.length, 1);
  assert.match(rebuilt[0].content, /too large to include/);
  assert.ok(rebuilt[0].content.includes(bigPath), 'reminder cites the dropped file path');
  assert.match(rebuilt[0].content, /sess\.jsonl/);
  assert.match(rebuilt[0].content, /without asking the user any further questions/);
});

test('j) COWCAT_* env vars win over CC_* fallback', async () => {
  const { loadConfig, ConfigError } = await import('../src/config.js');
  const touched = ['COWCAT_PROVIDER', 'CC_PROVIDER', 'COWCAT_MODEL', 'CC_MODEL', 'COWCAT_HOME'];
  const saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-cfg-'));
  try {
    delete process.env.COWCAT_PROVIDER;
    process.env.COWCAT_HOME = home;
    process.env.CC_PROVIDER = 'openai';
    process.env.CC_MODEL = 'gpt-6-sol'; // catalog-valid bare model on the openai preset
    let cfg = loadConfig();
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.model, 'gpt-6-sol');
    process.env.COWCAT_PROVIDER = 'anthropic';
    process.env.COWCAT_MODEL = 'claude-sonnet-5-5';
    cfg = loadConfig();
    assert.equal(cfg.provider, 'anthropic');
    assert.equal(cfg.model, 'claude-sonnet-5-5');
    // Bare model names outside the provider's catalog are rejected with guidance.
    process.env.COWCAT_MODEL = 'primary-model';
    assert.throws(() => loadConfig(), ConfigError, 'unknown bare model name must throw');
    process.env.COWCAT_MODEL = 'openai/gpt-6-sol';
    cfg = loadConfig();
    assert.equal(cfg.provider, 'openai', 'composite ref drives the provider');
  } finally {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('P0-1) system prompt is layered, >=6k chars, CowCat identity + key sections', async () => {
  const { buildSystemPrompt } = await import('../src/prompts/system.js');
  const blocks = buildSystemPrompt({ cwd: '/tmp/demo' });
  assert.equal(blocks.length, 2, 'system prompt must be [environment, main] blocks');
  const total = blocks.join('').length;
  assert.ok(total >= 6000, `prompt too small: ${total}`);
  assert.ok(total <= 13000, `prompt too large: ${total}`);
  assert.match(blocks[1], /You are CowCat/);
  for (const heading of ['Tool selection', 'Read before you write', 'Minimal', 'Parallel tool calls', 'Safety', 'git', 'Output style', 'TodoWrite', 'context']) {
    assert.match(blocks[1], new RegExp(heading, 'i'), `missing section: ${heading}`);
  }
  assert.doesNotMatch(blocks.join(''), /ccagent/i);
});

test('P0-2) anthropic request places cache breakpoints per the constant pattern', async () => {
  const { buildAnthropicRequestBody } = await import('../src/llm/anthropic.js');
  const cfg = { model: 'm', maxTokens: 32000, cache: true };
  const tools = [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }];
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  const body = buildAnthropicRequestBody(cfg, {
    system: ['env block', 'identity + main prompt'],
    messages, tools, stream: true,
  });
  // system: array, only the tail block carries cache_control
  assert.ok(Array.isArray(body.system));
  assert.equal(body.system.length, 2);
  assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(body.system[0].cache_control, undefined);
  // tools: never marked
  for (const t of body.tools || []) assert.equal(t.cache_control, undefined);
  // most recent message: tail block marked (tool_result tail counts)
  const last = body.messages[body.messages.length - 1];
  const tail = last.content[last.content.length - 1];
  assert.deepEqual(tail.cache_control, { type: 'ephemeral' });
  // earlier messages untouched
  assert.equal(JSON.stringify(body.messages[0]), JSON.stringify({ role: 'user', content: 'hello' }));
  // string-content tail message gets wrapped into a marked text block
  const body2 = buildAnthropicRequestBody(cfg, {
    system: 'single string system',
    messages: [{ role: 'user', content: 'first request' }],
    tools: [], stream: true,
  });
  assert.deepEqual(body2.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(body2.messages[0].content, [{ type: 'text', text: 'first request', cache_control: { type: 'ephemeral' } }]);
});

test('P0-2b) COWCAT_CACHE=off removes every cache_control', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { buildAnthropicRequestBody } = await import('../src/llm/anthropic.js');
  const saved = process.env.COWCAT_CACHE;
  const savedHome = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = mkdtempSync(join(tmpdir(), 'cowcat-cfg-'));
  try {
    process.env.COWCAT_CACHE = 'off';
    const cfg = loadConfig();
    assert.equal(cfg.cache, false);
    const body = buildAnthropicRequestBody(cfg, {
      system: ['env', 'main'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'Read', description: 'd', input_schema: {} }],
      stream: true,
    });
    assert.equal(JSON.stringify(body).includes('cache_control'), false);
  } finally {
    if (saved === undefined) delete process.env.COWCAT_CACHE;
    else process.env.COWCAT_CACHE = saved;
    if (savedHome === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = savedHome;
  }
});

test('P0-3) max_tokens default is 32000', async () => {
  const { loadConfig } = await import('../src/config.js');
  const savedMT = process.env.COWCAT_MAX_TOKENS ?? process.env.CC_MAX_TOKENS;
  const savedHome = process.env.COWCAT_HOME;
  delete process.env.COWCAT_MAX_TOKENS;
  delete process.env.CC_MAX_TOKENS;
  process.env.COWCAT_HOME = mkdtempSync(join(tmpdir(), 'cowcat-cfg-'));
  try {
    assert.equal(loadConfig().maxTokens, 32000);
  } finally {
    if (savedMT !== undefined) process.env.COWCAT_MAX_TOKENS = savedMT;
    if (savedHome === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = savedHome;
  }
});

test('P1-b1) plan mode: writes rejected as tool_result, read-only Bash allowed', async () => {
  const ctx = makeCtx();
  const perms = new Permissions('plan');
  assert.equal(perms.planReject('Read', {}), null);
  assert.equal(perms.planReject('Bash', { command: 'git status' }), null);
  assert.match(perms.planReject('Bash', { command: 'npm install lodash' }), /read-only/);
  assert.match(perms.planReject('Write', { file_path: '/x' }), /read-only/);

  const res = await run([
    {
      message: {
        content: [
          { type: 'tool_use', id: 'p1', name: 'Write', input: { file_path: join(ctx.cwd, 'x.txt'), content: 'x' } },
          { type: 'tool_use', id: 'p2', name: 'Bash', input: { command: 'git status' } },
        ],
        stopReason: 'tool_use',
      },
    },
    text('plan ready'),
  ], { messages: [{ role: 'user', content: 'explore then plan' }], ctx, permissions: perms });
  const results = res.messages[2].content;
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content, /plan mode/i);
  assert.equal(results[1].is_error, undefined, 'git status should execute in plan mode');
  assert.deepEqual(res.ctx.ui.planDenials, ['Write']);
  assert.match(res.finalText, /plan ready/);
});

test('P1-b2) denying one action does not terminate the turn', async () => {
  const ctx = makeCtx();
  const ui = new MockUI({ answers: ['n'] }); // deny the Write
  const res = await run([
    toolUse('w1', 'Write', { file_path: join(ctx.cwd, 'no.txt'), content: 'x' }),
    text('adjusted course'),
  ], {
    messages: [{ role: 'user', content: 'write a file' }],
    ctx, ui, permissions: new Permissions('default'),
  });
  const toolMsg = res.messages[2];
  assert.equal(toolMsg.content[0].is_error, true);
  assert.match(toolMsg.content[0].content, /denied/i);
  assert.equal(res.finalText, 'adjusted course', 'loop must continue after a denied action');
  assert.equal(res.ctx.ui.approvals.length, 1);
  assert.ok(!existsSync(join(ctx.cwd, 'no.txt')));
});

test('P1-b3) "always" decision is remembered: same tool+key is not asked again', async () => {
  const ctx = makeCtx();
  const ui = new MockUI({ answers: ['always'] });
  const file = join(ctx.cwd, 'a.txt');
  await run([
    toolUse('w1', 'Write', { file_path: file, content: '1' }),
    toolUse('w2', 'Write', { file_path: file, content: '2' }),
    text('done'),
  ], {
    messages: [{ role: 'user', content: 'twice' }],
    ctx, ui, permissions: new Permissions('default'),
  });
  assert.equal(ui.approvals.length, 1, 'second Write to same file must be auto-approved');
  assert.equal(readFileSync(file, 'utf8'), '2');
});

test('P1-a wire) loop events fire in order for a full tool turn', async () => {
  const pkgPath = join(AGENT_ROOT, 'package.json');
  const seen = [];
  const events = {
    onWaiting: () => seen.push('waiting'),
    onFirstDelta: () => seen.push('firstDelta'),
    onToolStart: () => seen.push('toolStart'),
    onToolSuccess: () => seen.push('toolSuccess'),
  };
  const provider = new MockProvider([
    { message: { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'e1', name: 'Read', input: { file_path: pkgPath } }], stopReason: 'tool_use' } },
    text('ok'),
  ]);
  const registry = makeRegistry();
  const ctx = makeCtx();
  await runLoop({
    provider, registry, system: SYS, messages: [{ role: 'user', content: 'go' }], ctx,
    ui: ctx.ui, permissions: ctx.permissions, config: ctx.config, events,
  });
  assert.deepEqual(seen, ['waiting', 'firstDelta', 'toolStart', 'toolSuccess', 'waiting', 'firstDelta']);
});

test('h) session JSONL is appended under the cowcat home dir and resumable', async () => {
  const ctx = makeCtx();
  const session = new Session(ctx.cwd, 'sess1').ensure();
  assert.ok(session.file.startsWith(ctx.home), 'session must live under ~/.cowcat');
  ctx.session = session;
  const userMsg = { role: 'user', content: 'q' };
  session.append({ type: 'user', message: userMsg });
  await run([text('resumable answer')], { messages: [userMsg], ctx });
  assert.ok(existsSync(session.file));
  const loaded = Session.load(session.file);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].content, 'q');
  rmSync(ctx.cwd, { recursive: true, force: true });
  rmSync(ctx.home, { recursive: true, force: true });
});

test('i) OpenAI-style usage field names (prompt_tokens/completion_tokens) are aggregated', async () => {
  const res = await run([
    { respond: () => ({ content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'echo hi' } }], stopReason: 'tool_use', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) },
    { respond: () => ({ content: [{ type: 'text', text: 'done' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }) },
  ], { messages: [{ role: 'user', content: 'count tokens' }] });
  assert.equal(res.usage.input, 27, 'prompt_tokens folds into usage.input');
  assert.equal(res.usage.output, 8, 'completion_tokens folds into usage.output');
});
