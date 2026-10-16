// Phase 1b: `network: 'ask'` — the per-command network decision must reach the
// tool, and it must reach it ONLY for the calls the user approved.
//
// This file uses a stand-in for the Bash tool that records what the sandbox
// layer would have been told, so the plumbing (loop → ctx → tool) is tested
// without spawning anything. The other half — that the flag actually removes the
// network namespace — lives in test/sandbox-linux.test.mjs, where bubblewrap
// exists. The dialog cases only make sense where the sandbox will enforce, so
// they skip elsewhere with the reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { Permissions } from '../src/permissions.js';
import { MockUI } from '../src/ui.js';
import { runLoop } from '../src/loop.js';
import { MockProvider, text, toolUse } from './mock-provider.js';
import { networkAskFor } from '../src/sandbox/exec.js';

const ASK_CONFIG = { maxTokens: 1024, maxContextTokens: 100000, sandbox: { mode: 'system', network: 'ask' } };

function ctxFor(config, over = {}) {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'cowcat-net-')),
    home: mkdtempSync(join(tmpdir(), 'cowcat-nethome-')),
    readSet: new Set(), state: {}, sessionId: 'net-test',
    ui: new MockUI(), permissions: new Permissions('default'),
    config, ...over,
  };
}

// Records what the sandbox layer was told, instead of running a command.
const seen = [];
const FakeBash = {
  name: 'Bash',
  description: 'stand-in for the Bash tool',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute(input, ctx) {
    seen.push({ command: input.command, granted: ctx.networkApproved === true });
    return { ok: true, output: 'ok', exitCode: 0 };
  },
};

const registry = () => { const r = new ToolRegistry(); r.register(FakeBash); return r; };

const script = (command) => [toolUse('tu_1', 'Bash', { command }), text('done')];

async function runOnce({ config, ui, permissions }) {
  seen.length = 0;
  const ctx = ctxFor(config);
  ctx.ui = ui || ctx.ui;
  ctx.permissions = permissions || ctx.permissions;
  const res = await runLoop({
    provider: new MockProvider(script('npm install lodash')),
    registry: registry(), system: 'test',
    messages: [{ role: 'user', content: 'install it' }],
    ctx, ui: ctx.ui, permissions: ctx.permissions, config: ctx.config,
  });
  // MockUI records tool cards as objects ({name, summary}); flatten for matching.
  const cards = ctx.ui.calls.map((c) => `${c.name} ${c.summary}`).join('\n');
  const text = res.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]))
    .map((b) => b.content ?? b.text ?? '')
    .join('\n');
  return { ctx, cards, text };
}

const enforced = networkAskFor(ASK_CONFIG, { cwd: process.cwd() }) ? false : 'system sandbox cannot run here (no bwrap backend)';

test('network ask: an approved command carries the grant to the tool', { skip: enforced }, async () => {
  const ui = new MockUI({ answers: ['y'] });
  const { cards } = await runOnce({ config: ASK_CONFIG, ui });
  assert.equal(ui.approvals.length, 1, 'the network decision goes through the approval prompt');
  assert.deepEqual(seen, [{ command: 'npm install lodash', granted: true }]);
  assert.match(cards, /needs network: sandbox/, 'the card says what is being approved');
});

test('network ask: always-approved commands keep the grant without re-asking', { skip: enforced }, async () => {
  const ui = new MockUI({ answers: ['always'] });
  const { ctx } = await runOnce({ config: ASK_CONFIG, ui });
  assert.deepEqual(seen, [{ command: 'npm install lodash', granted: true }]);
  // Second run in the same session: no dialog, but the grant must survive (an
  // `always` remembers the permission, so it has to remember the network too).
  seen.length = 0;
  const ui2 = new MockUI();
  const ctx2 = ctxFor(ASK_CONFIG, { ui: ui2, permissions: ctx.permissions });
  await runLoop({
    provider: new MockProvider(script('npm install lodash')),
    registry: registry(), system: 'test',
    messages: [{ role: 'user', content: 'again' }],
    ctx: ctx2, ui: ui2, permissions: ctx2.permissions, config: ctx2.config,
  });
  assert.equal(ui2.approvals.length, 0, 'always-approved: no second dialog');
  assert.deepEqual(seen, [{ command: 'npm install lodash', granted: true }]);
});

test('network ask: a denial runs nothing and grants nothing', { skip: enforced }, async () => {
  const ui = new MockUI({ answers: ['n'] });
  const { text } = await runOnce({ config: ASK_CONFIG, ui });
  assert.deepEqual(seen, [], 'the denied command never reaches the tool');
  assert.equal(ui.approvals.length, 1);
  assert.match(text, /denied/i, 'the model is told the user denied it');
});

test('network ask: yolo mode never grants the network (ask must not become on)', async () => {
  // Runs everywhere: the assertion is that no grant is handed out, which holds
  // whether or not this machine can enforce the sandbox at all.
  const ui = new MockUI();
  await runOnce({ config: ASK_CONFIG, ui, permissions: new Permissions('yolo') });
  assert.equal(ui.approvals.length, 0, 'yolo asks nothing');
  assert.deepEqual(seen, [{ command: 'npm install lodash', granted: false }]);
});

test('network ask: light mode adds no network dialog and no marker', async () => {
  const ui = new MockUI({ answers: ['y'] });
  await runOnce({ config: { maxTokens: 1024, maxContextTokens: 100000, sandbox: 'light' }, ui });
  // The ordinary Bash prompt in default permission mode is pre-existing
  // behaviour; what must NOT appear is the network marker or a grant.
  assert.equal(ui.approvals.length, 1);
  assert.deepEqual(seen, [{ command: 'npm install lodash', granted: false }]);
  assert.ok(!ui.calls.join('\n').includes('needs network'), 'the marker is system-mode only');
});
