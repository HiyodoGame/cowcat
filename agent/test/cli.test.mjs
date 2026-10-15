// CLI-experience batch: args parsing, project context, session resume, setup/doctor, /init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../src/cliargs.js';
import { findProjectContext, PROJECT_SECTION } from '../src/project.js';
import { Session } from '../src/session.js';
import { runDoctorChecks, mergeSetupConfig, saveSetupConfig } from '../src/doctor.js';
import { generateCowcatMd } from '../src/init.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { GlobTool } from '../src/tools/glob.js';
import { GrepTool } from '../src/tools/grep.js';
import { BashTool } from '../src/tools/bash.js';
import { MockUI } from '../src/ui.js';
import { MockProvider, text, toolUse } from './mock-provider.js';

function makeRegistry(names = ['read', 'edit', 'write', 'glob', 'grep', 'bash']) {
  const all = { read: ReadTool, edit: EditTool, write: WriteTool, glob: GlobTool, grep: GrepTool, bash: BashTool };
  const reg = new ToolRegistry();
  for (const n of names) reg.register(all[n]);
  return reg;
}

function withHome(fn) {
  const saved = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = mkdtempSync(join(tmpdir(), 'cowcat-cli-'));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.COWCAT_HOME;
      else process.env.COWCAT_HOME = saved;
    });
}

test('args: version / continue / resume-with-and-without-file / subcommands', () => {
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-c']).continueLast, true);
  assert.equal(parseArgs(['--continue']).continueLast, true);
  assert.equal(parseArgs(['--resume', '/tmp/x.jsonl']).resume, '/tmp/x.jsonl');
  const noArg = parseArgs(['--resume']);
  assert.equal(noArg.resume, null);
  assert.equal(noArg.resumeList, true);
  const shortNoArg = parseArgs(['-r']);
  assert.equal(shortNoArg.resumeList, true);
  assert.equal(parseArgs(['setup']).command, 'setup');
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  const mixed = parseArgs(['--yolo', 'doctor']);
  assert.equal(mixed.command, 'doctor');
  assert.equal(mixed.yolo, true);
  const prompt = parseArgs(['--print', '读一下 index.js']);
  assert.equal(prompt.prompt, '读一下 index.js');
  assert.equal(prompt.print, true);
});

test('project context: nearest dir wins, COWCAT.md > AGENTS.md > CLAUDE.md, none -> null', () => {
  const root = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
  const sub = join(root, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  assert.equal(findProjectContext(sub), null);
  writeFileSync(join(root, 'CLAUDE.md'), 'root claude rules');
  let ctx = findProjectContext(sub);
  assert.equal(ctx.name, 'CLAUDE.md');
  assert.equal(ctx.content, 'root claude rules');
  writeFileSync(join(root, 'AGENTS.md'), 'root agents rules');
  ctx = findProjectContext(sub);
  assert.equal(ctx.name, 'AGENTS.md');
  writeFileSync(join(sub, 'COWCAT.md'), 'app cowcat rules');
  ctx = findProjectContext(sub);
  assert.equal(ctx.name, 'COWCAT.md');
  assert.equal(ctx.content, 'app cowcat rules');
  assert.match(PROJECT_SECTION(ctx), /app cowcat rules/);
  assert.match(PROJECT_SECTION(ctx), /Project instructions/);
});

test('session: cwd header record written; loader ignores it; list is newest-first', () =>
  withHome(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    const s1 = new Session(cwd, 'older').ensure();
    writeFileSync(s1.file, `${JSON.stringify({ type: 'meta', cwd })}\n${JSON.stringify({ message: { role: 'user', content: 'hi1' } })}\n`);
    const s2 = new Session(cwd, 'newer').ensure();
    writeFileSync(s2.file, `${JSON.stringify({ type: 'meta', cwd })}\n${JSON.stringify({ message: { role: 'user', content: 'hi2' } })}\n`);
    const loaded = Session.load(s2.file);
    assert.equal(loaded.length, 1, 'meta record must be skipped by the loader');
    assert.equal(loaded[0].content, 'hi2');
    const list = Session.list(cwd);
    assert.equal(list.length, 2);
    assert.ok(list[0].includes('newer'), 'continue picks the newest session');
    // header: a fresh session records its cwd on first ensure
    const s3 = new Session(cwd, 'hdr').ensure();
    const firstLine = readFileSync(s3.file, 'utf8').split('\n')[0];
    const meta = JSON.parse(firstLine);
    assert.equal(meta.type, 'meta');
    assert.equal(meta.cwd, cwd);
  }));

test('doctor: checklist passes and fails correctly; ping result reflected', async () => {
  const good = await runDoctorChecks(
    { provider: 'anthropic', baseURL: 'https://x', apiKey: 'k', model: 'm' },
    { hasConfigFile: true, ping: async () => {} },
  );
  assert.equal(good.ok, true);
  assert.equal(good.items.length, 7);
  assert.ok(good.items.every((i) => i.ok));

  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const bad = await runDoctorChecks(
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { hasConfigFile: false, ping: async () => { throw new Error('HTTP 401'); } },
    );
    assert.equal(bad.ok, false);
    const byName = Object.fromEntries(bad.items.map((i) => [i.name, i]));
    assert.equal(byName['config file'].ok, false);
    assert.equal(byName['model ref'].ok, true, 'catalog model ref resolves');
    assert.equal(byName['base URL'].ok, true, 'preset default baseURL counts as present');
    assert.equal(byName['API key'].ok, false);
    assert.match(byName['API key'].detail, /ANTHROPIC_API_KEY/, 'missing env var is named');
    assert.equal(byName['model catalog'].ok, true);
    assert.match(byName['API connectivity'].detail, /401/);
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }

  const noPing = await runDoctorChecks({ provider: 'openai', baseURL: 'u', apiKey: 'k', model: 'm' }, {});
  assert.equal(noPing.items.some((i) => i.name === 'API connectivity'), false, 'no ping fn -> no connectivity item');
  assert.equal(noPing.ok, true);
});

test('setup: merge keeps untouched fields; state keys migrate to state.json', () =>
  withHome(async () => {
    const existing = { installId: 'abc123', maxTokens: 1234, provider: 'openai' };
    const merged = mergeSetupConfig({ provider: 'anthropic', baseURL: 'https://api.kimi.com/coding', apiKey: 'sk', model: 'kimi-for-coding' }, existing);
    assert.equal(merged.installId, undefined, 'state keys never live in the config layer');
    assert.equal(merged.maxTokens, 1234);
    assert.equal(merged.provider, 'anthropic');
    assert.equal(merged.apiKey, 'sk');
    // round-trip through the real file: installId moves to state.json
    const { saveSetupConfig } = await import('../src/doctor.js');
    const { readState } = await import('../src/config.js');
    writeFileSync(join(process.env.COWCAT_HOME, 'config.json'), JSON.stringify(existing));
    const { file, config } = saveSetupConfig({ apiKey: 'new-key' });
    assert.equal(config.installId, undefined);
    assert.equal(config.apiKey, 'new-key');
    assert.equal(config.provider, 'openai', 'untouched wizard fields keep old values');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.installId, undefined, 'config.json no longer carries state');
    assert.equal(readState().installId, 'abc123', 'installId migrated to state.json');
  }));

test('/init: draft generated read-only (Read/Glob/Grep/Bash only, writes rejected)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-init-'));
  writeFileSync(join(cwd, 'package.json'), '{"name":"demo"}');
  const registry = makeRegistry();
  const ui = new MockUI();
  const config = { maxTokens: 512, maxContextTokens: 100000 };
  const provider = new MockProvider([
    toolUse('w1', 'Write', { file_path: join(cwd, 'evil.md'), content: 'x' }),
    text('# COWCAT.md\n\n- demo project'),
  ]);
  const draft = await generateCowcatMd({ provider, registry, config, ui, cwd });
  assert.match(draft, /# COWCAT\.md/);
  const subReq = provider.requests[0];
  assert.deepEqual(subReq.tools.map((t) => t.name).sort(), ['Bash', 'Glob', 'Grep', 'Read']);
  const errResults = provider.requests[1].messages
    .flatMap((m) => m.content || [])
    .filter((b) => b.type === 'tool_result' && b.is_error);
  assert.ok(errResults.some((b) => /plan mode/i.test(b.content)), 'write attempt must be rejected in /init exploration');
  assert.ok(!existsSync(join(cwd, 'evil.md')));
});

test('/init: provider script exhaustion safety — plain text response works as draft', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-init-'));
  const registry = makeRegistry(['read', 'glob', 'grep', 'bash']);
  const provider = new MockProvider([text('plain draft, no tools needed')]);
  const draft = await generateCowcatMd({ provider, registry, config: { maxTokens: 256, maxContextTokens: 10000 }, ui: new MockUI(), cwd });
  assert.match(draft, /plain draft/);
});
