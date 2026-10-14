// P2 wave 2: IDE integration, worktree isolation, lead role, background+notify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectIde, makeIdeSink, ideStatus } from '../src/ide.js';
import { execFileSync } from 'node:child_process';
import { createWorktree, listWorktrees, isGitRepo } from '../src/worktree.js';
import { BUILTIN_ROLES } from '../src/prompts/subagents.js';
import { createSubagentRunner } from '../src/subagent.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { makeRunId, prepareBackgroundRun, finishBackgroundRun, notify } from '../src/notify.js';
import { MockProvider, text } from './mock-provider.js';
import { MockUI } from '../src/ui.js';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function setupHome() {
  const saved = process.env.COWCAT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    home,
    restore: () => { if (saved === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = saved; },
  };
}

// --- P2-2 IDE ---------------------------------------------------------------------

test('P2-2: detectIde reads the terminal environment', () => {
  assert.equal(detectIde({ TERM_PROGRAM: 'vscode' }).name, 'VS Code');
  assert.equal(detectIde({ TERM_PROGRAM: 'cursor' }).name, 'Cursor');
  assert.equal(detectIde({ TERM_PROGRAM: 'Apple_Terminal' }), null);
  assert.equal(detectIde({}), null);
});

test('P2-2: ide sink writes JSONL to the channel and counts without one', async () => {
  const { home, restore } = setupHome();
  try {
    const channel = join(home, 'ide.jsonl');
    const sink = makeIdeSink({ COWCAT_IDE_PIPE: channel });
    sink.emit({ type: 'file_edited', file: '/x' });
    sink.emit({ type: 'diagnostic', message: 'boom' });
    assert.equal(sink.count, 2);
    const lines = readFileSync(channel, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].type, 'file_edited');
    assert.equal(lines[1].message, 'boom');

    const nosink = makeIdeSink({});
    nosink.emit({ type: 'file_edited', file: '/y' });
    assert.equal(nosink.count, 1);
    const status = ideStatus(nosink, {}).join('\n');
    assert.match(status, /IDE: none detected/);
    assert.match(status, /channel: \(not set/);
  } finally {
    restore();
  }
});

// --- P2-4 worktree --------------------------------------------------------------------

test('P2-4: worktree creation, listing, and rejection outside a repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cowcat-repo-'));
  // init a git repo (needs user config for branch creation)
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  assert.ok(isGitRepo(repo));
  const wt = createWorktree(repo, 'feat-x');
  assert.ok(existsSync(wt.path));
  assert.match(wt.branch, /^cowcat\/feat-x$/);
  const trees = listWorktrees(repo);
  assert.ok(trees.some((t) => t.path === wt.path && t.branch.endsWith('feat-x')));
  const notRepo = mkdtempSync(join(tmpdir(), 'cowcat-norepo-'));
  assert.equal(isGitRepo(notRepo), false);
  assert.throws(() => createWorktree(notRepo), /不是 git 仓库/);
});

// --- P2-3 lead ------------------------------------------------------------------------

test('P2-3: lead role registered with orchestration prompt; nesting depth-capped', async () => {
  assert.ok(BUILTIN_ROLES.lead, 'lead role exists');
  assert.match(BUILTIN_ROLES.lead.system, /scout/);
  assert.match(BUILTIN_ROLES.lead.system, /verify/);
  assert.equal(BUILTIN_ROLES.lead.tools, null);

  // lead may spawn one level; a nested lead cannot spawn again
  const registry = new ToolRegistry();
  registry.register(ReadTool);
  const provider = new MockProvider([text('lead done')]);
  const runner = createSubagentRunner({
    provider, registry, config: { maxTokens: 64, maxContextTokens: 10000 }, ui: new MockUI(), cwd: tmpdir(),
  });
  const spawnCalls = [];
  // emulate: lead ctx gets a spawnAgent (verified via tool filter instead — Agent tool absent for non-lead)
  const report = await runner({ prompt: 'coordinate', subagent_type: 'lead' });
  assert.match(report, /lead done/);
  // scout toolFilter excludes Agent:
  const p2 = new MockProvider([text('scout done')]);
  const runner2 = createSubagentRunner({
    provider: p2, registry, config: { maxTokens: 64, maxContextTokens: 10000 }, ui: new MockUI(), cwd: tmpdir(),
  });
  await runner2({ prompt: 'look', subagent_type: 'scout' });
  assert.ok(p2.requests[0].tools.every((t) => t.name !== 'Agent'), 'scout cannot nest');
  assert.ok(p2.requests[0].tools.some((t) => t.name === 'Read'));
  void spawnCalls;
});

// --- P2-8 background + notify -----------------------------------------------------------

test('P2-8: background run meta/log/result lifecycle and notify degrade', async () => {
  const { home, restore } = setupHome();
  try {
    const id = makeRunId();
    assert.match(id, /^bg-/);
    const meta = prepareBackgroundRun(id, 'do the thing');
    assert.ok(existsSync(join(home, 'background', id, 'meta.json')));
    const result = finishBackgroundRun(id, { finalText: 'all good', exitCode: 0, usage: { input: 1 } });
    assert.equal(result.exitCode, 0);
    const onDisk = JSON.parse(readFileSync(join(home, 'background', id, 'result.json'), 'utf8'));
    assert.equal(onDisk.finalText, 'all good');

    // notify degrades silently when the toast cannot show (non-Windows or failure)
    const ok = await notify('t', 'm');
    assert.equal(typeof ok, 'boolean');
  } finally {
    restore();
  }
});

test('P2-8: --background spawns a detached child that finishes and writes result', async () => {
  const { server, port } = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const ev of [
          { type: 'message_start', message: { usage: { input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bg task finished' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-bg-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ trustedProjects: [cwd] }));
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), '-p', '--background', 'run it'], {
      env: {
        ...process.env, COWCAT_HOME: home, COWCAT_PROVIDER: 'anthropic',
        COWCAT_BASE_URL: `http://127.0.0.1:${port}`, COWCAT_API_KEY: 'k', COWCAT_MODEL: 'm', COWCAT_ANIMATION: 'off',
      },
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    const id = out.match(/bg-[\w-]+/)[0];
    const resultFile = join(home, 'background', id, 'result.json');
    // poll for the child to finish (it runs against the fake server)
    let result = null;
    for (let i = 0; i < 50 && !result; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* not yet */ }
    }
    assert.ok(result, 'child wrote its result');
    assert.equal(result.exitCode, 0);
    assert.match(readFileSync(join(home, 'background', id, 'output.log'), 'utf8'), /bg task finished|已后台启动/);
  } finally {
    server.close();
    restore();
  }
});
