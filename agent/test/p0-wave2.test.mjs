// P0 wave 2: checkpoints + /rewind (P0-4), compact dual-template + boundary
// (P0-5), slash command helpers (P0-6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLoop } from '../src/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { Session } from '../src/session.js';
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from '../src/checkpoint.js';
import { compactConversation } from '../src/prompts/compact.js';
import {
  emptyUsage, addUsage, formatCostReport, formatStatus,
  exportSessionToMarkdown, forkSessionFile, persistTheme, THEMES,
} from '../src/slashcmds.js';
import { UI, MockUI } from '../src/ui.js';
import { MockProvider, text, toolUse } from './mock-provider.js';
import { Permissions } from '../src/permissions.js';

function makeCtx(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-p0w2-'));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  const session = new Session(cwd, 's1').ensure();
  return {
    cwd, home, session, sessionId: session.id, readSet: new Set(), state: {},
    ui: new MockUI(), permissions: new Permissions('default'),
    config: { maxTokens: 256, maxContextTokens: 100000 },
    ...over,
  };
}

function writeRegistry() {
  const reg = new ToolRegistry();
  for (const t of [ReadTool, EditTool, WriteTool]) reg.register(t);
  return reg;
}

// --- P0-4 --------------------------------------------------------------------

test('P0-4: edit -> checkpoint -> re-edit -> rewind restores files and truncates messages', async () => {
  const ctx = makeCtx();
  const file = join(ctx.cwd, 'a.txt');
  writeFileSync(file, 'version one\n');
  ctx.readSet.add(file);
  const registry = writeRegistry();

  // turn 1: edit to v2 (user record appended like the CLI's runTurn does)
  const p1 = new MockProvider([toolUse('e1', 'Edit', { file_path: file, old_string: 'version one', new_string: 'version two' }), text('v2 done')]);
  ctx.session.append({ type: 'user', message: { role: 'user', content: 'first' } });
  const r1 = await runLoop({ provider: p1, registry, system: 's', messages: [{ role: 'user', content: 'first' }], ctx, ui: ctx.ui, permissions: ctx.permissions, config: ctx.config });
  assert.equal(readFileSync(file, 'utf8'), 'version two\n');
  assert.equal(r1.diffs.length, 1);

  // turn 2: edit to v3
  const p2 = new MockProvider([toolUse('e2', 'Edit', { file_path: file, old_string: 'version two', new_string: 'version three' }), text('v3 done')]);
  ctx.session.append({ type: 'user', message: { role: 'user', content: 'second' } });
  const messages2 = [{ role: 'user', content: 'second' }];
  await runLoop({ provider: p2, registry, system: 's', messages: messages2, ctx, ui: ctx.ui, permissions: ctx.permissions, config: ctx.config });
  assert.equal(readFileSync(file, 'utf8'), 'version three\n');

  // checkpoints recorded and monotonic
  const cps = listCheckpoints(ctx);
  assert.equal(cps.length, 2);
  assert.equal(cps[0].id, 2, 'newest first');
  // checkpoint record persisted next to snapshots
  assert.match(cps[0].record.files[0].path, /a\.txt/);
  assert.equal(cps[0].record.files[0].tool, 'Edit');
  // session JSONL carries checkpoint records
  const jsonl = readFileSync(ctx.session.file, 'utf8');
  assert.match(jsonl, /"type":"checkpoint"/);

  // rewind: restore v1 and truncate the conversation to before checkpoint #1
  const restored = restoreCheckpoint(ctx, 1);
  assert.deepEqual(restored, [file]);
  assert.equal(readFileSync(file, 'utf8'), 'version one\n', 'file content rolled back');
  const truncated = Session.load(ctx.session.file, { upToCheckpointId: 1 });
  assert.equal(truncated.length, 2, 'turn 1 (user+assistant) kept, turn 2 rolled back');
  const truncated2 = Session.load(ctx.session.file, { upToCheckpointId: 2 });
  assert.equal(truncated2.length, 6, 'turn 1 complete + turn 2 up to its edit — result rolled back');
});

test('P0-4: Write of a brand-new file creates no checkpoint (nothing to restore)', () => {
  const ctx = makeCtx();
  const cp = createCheckpoint(ctx, [{ file_path: 'new.txt', tool: 'Write' }], null);
  assert.equal(cp, null);
});

// --- P0-5 --------------------------------------------------------------------

test('P0-5: 30-message history uses the recent-portion template and writes a boundary', async () => {
  const ctx = makeCtx();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg ${i}`,
  }));
  const provider = new MockProvider([
    { respond: (req) => ({ content: [{ type: 'text', text: `<analysis>x</analysis>\n<summary>Summary of msgs 0-23</summary>` }] }) },
    text('after compact'),
  ], { countTokens: 99999 });
  const r = await runLoop({
    provider, registry: writeRegistry(), system: 's', messages, ctx, ui: ctx.ui,
    permissions: ctx.permissions, config: { maxTokens: 256, maxContextTokens: 10 },
  });
  assert.equal(r.compacted, 1);
  // recent-portion: wrapper + last KEEP_RECENT(6) messages kept verbatim
  assert.equal(r.messages.length, 1 + 6 + 1, 'wrapper + 6 recent messages + final assistant reply');
  assert.match(r.messages[0].content, /continued from a previous conversation/);
  assert.equal(r.messages[1].content, 'msg 24', 'recent messages stay verbatim');
  // session JSONL: boundary + compacted marker written
  const jsonl = readFileSync(ctx.session.file, 'utf8');
  assert.match(jsonl, /"type":"compact_boundary"/);
  assert.match(jsonl, /"type":"compacted"/);
  // resume replays the summary instead of the raw history
  const replayed = Session.load(ctx.session.file);
  const boundaryMsg = replayed.find((m) => m.__compact);
  assert.ok(boundaryMsg, 'boundary summary present on replay');
  assert.ok(!replayed.some((m) => m.content === 'msg 0'), 'dropped history is not replayed');
});

test('P0-5: custom instruction reaches the summarizer; short history stays full-template', async () => {
  const provider = new MockProvider([
    { respond: (req) => ({ content: [{ type: 'text', text: '<summary>S</summary>' }] }) },
  ]);
  const seen = provider.requests;
  const short = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
  const res = await compactConversation({
    provider, messages: short, customInstruction: 'focus only on API changes',
  });
  assert.equal(res.messages.length, 1, 'short history -> full template');
  assert.match(seen[0].messages[0].content, /focus only on API changes/);
  assert.equal(res.compactedCount, 2);
  assert.equal(res.keptRecent, 0);
});

// --- P0-6 --------------------------------------------------------------------

test('P0-6: /cost report aggregates usage and labels the estimate', () => {
  const usage = addUsage(addUsage(emptyUsage(), { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000 }), { input_tokens: 50 });
  const out = formatCostReport({ model: 'kimi-for-coding', turns: 3, toolCalls: 7, usage, startedAt: Date.now() - 5 * 60000 });
  assert.match(out, /model: kimi-for-coding/);
  assert.match(out, /turns: 3 \| tool calls: 7/);
  assert.match(out, /input: 150  output: 20  cache_read: 5000/);
  assert.match(out, /估算/);
});

test('P0-6: /status masks the base URL and reports trust + context', () => {
  const out = formatStatus({
    version: '0.4.0', provider: 'anthropic', baseURL: 'https://api.kimi.com/coding',
    model: 'kimi-for-coding', mode: 'default', trusted: false,
    contextUsed: 5000, contextMax: 100000, startedAt: Date.now() - 3 * 60000,
  });
  assert.match(out, /provider: anthropic  \(https:\/\/api\.kimi\.com\/coding\)/);
  assert.match(out, /folder trusted: no \(read-only\)/);
  assert.match(out, /context: ~5,000 \/ 100,000 est\. tokens \(5%\)/);
});

test('P0-6: /export renders a readable markdown transcript', () => {
  const ctx = makeCtx();
  ctx.session.append({ type: 'user', message: { role: 'user', content: 'hi there' } });
  ctx.session.append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/x' } }] } });
  ctx.session.append({ type: 'checkpoint', id: 1, files: [], label: null });
  const md = exportSessionToMarkdown(ctx.session.file);
  assert.match(md, /# CowCat session export/);
  assert.match(md, /## user/);
  assert.match(md, /hi there/);
  assert.match(md, /## CowCat/);
  assert.match(md, /`Read`/);
  assert.match(md, /checkpoint #1/);
});

test('P0-6: /fork copies the session file under a new id and keeps the original', () => {
  const ctx = makeCtx();
  ctx.session.append({ type: 'user', message: { role: 'user', content: 'original' } });
  const fork = forkSessionFile(ctx.session, 'my fork!');
  assert.equal(fork.id, 'my-fork');
  assert.ok(existsSync(fork.file));
  assert.match(readFileSync(fork.file, 'utf8'), /original/);
  assert.match(readFileSync(ctx.session.file, 'utf8'), /original/);
  assert.notEqual(fork.file, ctx.session.file);
});

test('P0-6: /theme switches the palette immediately and persists to state.json', () => {
  const ctx = makeCtx();
  const ui = new UI({ colors: false });
  assert.ok(ui.setTheme('light'));
  assert.equal(THEMES.light.name, 'light');
  assert.equal(ui.themeName, 'light');
  assert.ok(ui.setTheme('dark'));
  persistTheme('light');
  const onDisk = JSON.parse(readFileSync(join(ctx.home, 'state.json'), 'utf8'));
  assert.equal(onDisk.theme, 'light');
});
