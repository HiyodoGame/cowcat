// P1 wave 3: custom commands/agents/skills, background tasks, subagent roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCustom, expandCommand, customHelpLines } from '../src/custom.js';
import { BackgroundRegistry } from '../src/background.js';
import { TaskOutputTool } from '../src/tools/taskoutput.js';
import { TaskStopTool } from '../src/tools/taskstop.js';
import { BashTool } from '../src/tools/bash.js';
import { createSubagentRunner, resolveSubagentSpec } from '../src/subagent.js';
import { BUILTIN_ROLES } from '../src/prompts/subagents.js';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { WriteTool } from '../src/tools/write.js';
import { MockProvider, text, toolUse } from './mock-provider.js';
import { MockUI } from '../src/ui.js';

function setupHome() {
  const saved = process.env.COWCAT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    home,
    restore: () => { if (saved === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = saved; },
  };
}

// --- P1-5 custom loader --------------------------------------------------------

test('P1-5: commands/agents/skills load from user + project levels, project wins', () => {
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    // user level
    mkdirSync(join(home, 'commands'), { recursive: true });
    writeFileSync(join(home, 'commands', 'review.md'), `---
description: Review the current diff
argument-hint: [文件]
---
请审查当前改动，重点关注 $ARGUMENTS。`);
    writeFileSync(join(home, 'commands', 'broken.md'), 'no frontmatter here');
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'auditor.md'), `---
description: Security audit role
tools: Read,Grep
model: small-model
---
You audit code for security issues. Report findings with evidence.`);
    mkdirSync(join(home, 'skills', 'commit-msg'), { recursive: true });
    writeFileSync(join(home, 'skills', 'commit-msg', 'SKILL.md'), `---
name: commit-msg
description: Write conventional commit messages
---
Analyze the staged diff and output a conventional-commit message.`);
    // project level override
    mkdirSync(join(cwd, '.cowcat', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.cowcat', 'commands', 'review.md'), `---
description: Project review rules
---
项目级审查：$ARGUMENTS（项目规则优先）`);

    const custom = loadCustom(cwd);
    assert.equal(custom.commands.review.description, 'Project review rules', 'project overrides user');
    assert.equal(custom.commands.review.body.includes('$ARGUMENTS'), true);
    assert.ok(!custom.commands.broken, 'bad frontmatter skipped');
    assert.equal(custom.warnings.length, 1);
    assert.match(custom.warnings[0], /frontmatter/);
    assert.equal(custom.agents.auditor.tools, 'Read,Grep');
    assert.equal(custom.agents.auditor.model, 'small-model');
    assert.equal(custom.skills['commit-msg'].description, 'Write conventional commit messages');

    // $ARGUMENTS expansion
    const expanded = expandCommand(custom.commands.review, 'src/auth.ts');
    assert.match(expanded, /项目级审查：src\/auth\.ts（项目规则优先）/);
    assert.ok(customHelpLines({ review: custom.commands.review })[0].startsWith('  /review'));
  } finally {
    restore();
  }
});

// --- P1-7 roles -----------------------------------------------------------------

test('P1-7: four builtin roles with correct tool whitelists and plan wording', () => {
  assert.deepEqual(Object.keys(BUILTIN_ROLES).sort(), ['general', 'lead', 'plan', 'scout', 'verify']);
  assert.deepEqual(BUILTIN_ROLES.scout.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.deepEqual(BUILTIN_ROLES.verify.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.equal(BUILTIN_ROLES.general.tools, null, 'general inherits everything');
  assert.match(BUILTIN_ROLES.plan.system, /plan/i);
  assert.match(BUILTIN_ROLES.plan.system, /Implementation|changes/i);
  assert.match(BUILTIN_ROLES.verify.system, /PASS|FAIL/);
});

test('P1-7: resolveSubagentSpec — custom beats builtin, unknown falls back to scout', () => {
  const customAgents = { auditor: { body: 'custom auditor system', tools: 'Read,Grep', model: 'm1' } };
  const custom = resolveSubagentSpec({ subagent_type: 'auditor', customAgents });
  assert.equal(custom.system, 'custom auditor system');
  assert.deepEqual(custom.tools, ['Read', 'Grep']);
  assert.equal(custom.model, 'm1');
  const builtin = resolveSubagentSpec({ subagent_type: 'verify' });
  assert.equal(builtin.system, BUILTIN_ROLES.verify.system);
  const fallback = resolveSubagentSpec({ subagent_type: 'nope' });
  assert.equal(fallback.system, BUILTIN_ROLES.scout.system);
  // skill body injection
  const withSkill = resolveSubagentSpec({ skillBody: 'SKILL INSTRUCTIONS' });
  assert.match(withSkill.system, /SKILL INSTRUCTIONS/);
});

test('P1-7: runner filters tools per role and passes model; scout write rejected', async () => {
  const registry = new ToolRegistry();
  for (const t of [ReadTool, WriteTool]) registry.register(t);
  const provider = new MockProvider([
    toolUse('w1', 'Write', { file_path: '/tmp/x', content: 'y' }),
    text('could not write, reported instead'),
  ]);
  const runner = createSubagentRunner({
    provider, registry, config: { maxTokens: 64, maxContextTokens: 10000 }, ui: new MockUI(),
    cwd: tmpdir(), customAgents: {},
  });
  const report = await runner({ prompt: 'inspect', subagent_type: 'scout' });
  assert.match(report, /could not write/);
  // scout toolFilter: only read-only tools exposed
  assert.ok(provider.requests[0].tools.length > 0);
  assert.ok(provider.requests[0].tools.every((t) => ['Read', 'Glob', 'Grep', 'Bash'].includes(t.name)), 'scout exposes read-only subset');
  // write was rejected inside the sub-loop (plan perms) — file must not exist
  assert.ok(!existsSync('/tmp/x'));
});

test('P1-7: resume continues from the original transcript', async () => {
  const { restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    const sess = new Session(cwd, 'sub1').ensure();
    sess.append({ type: 'user', message: { role: 'user', content: 'original question' } });
    sess.append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'original answer' }] } });

    const registry = new ToolRegistry();
    registry.register(ReadTool);
    const provider = new MockProvider([text('resumed answer')]);
    const runner = createSubagentRunner({
      provider, registry, config: { maxTokens: 64, maxContextTokens: 10000 }, ui: new MockUI(), cwd,
    });
    await runner({ prompt: 'continue please', resume: sess.file });
    const sent = provider.requests[0].messages;
    assert.equal(sent.length, 3, 'transcript + continuation prompt');
    assert.equal(sent[0].content, 'original question');
    assert.equal(sent[1].content[0].text, 'original answer');
    // reminder rides before the user text in the same message
    const tail = sent[2].content;
    assert.equal(Array.isArray(tail) ? tail[tail.length - 1].text : tail, 'continue please');
  } finally {
    restore();
  }
});

test('P1-5/7: skill body is injected via getSkillBody', async () => {
  const registry = new ToolRegistry();
  registry.register(ReadTool);
  const provider = new MockProvider([text('skill applied')]);
  const runner = createSubagentRunner({
    provider, registry, config: { maxTokens: 64, maxContextTokens: 10000 }, ui: new MockUI(), cwd: tmpdir(),
    getSkillBody: (name) => (name === 'commit-msg' ? 'Analyze the staged diff.' : null),
  });
  await runner({ prompt: 'write a commit message', skill: 'commit-msg' });
  assert.match(provider.requests[0].system, /# Skill instructions/);
  assert.match(provider.requests[0].system, /Analyze the staged diff\./);
});

// --- P1-6 background tasks -------------------------------------------------------

test('P1-6: background start -> snapshot running -> block wait completes -> output', async () => {
  const reg = new BackgroundRegistry();
  const slow = `"${process.execPath}" -e "setTimeout(()=>console.log('bg-done'), 800)"`;
  const task = reg.start(slow, { cwd: tmpdir(), timeout: 30_000 });
  assert.match(task.id, /^task_/);
  const snap1 = reg.snapshot(task);
  assert.equal(snap1.running, true);

  const ctx = { background: reg };
  const immediate = await TaskOutputTool.execute({ task_id: task.id }, ctx);
  assert.match(immediate.output, /"running": true/);

  const blocked = await TaskOutputTool.execute({ task_id: task.id, block: true, timeout: 10_000 }, ctx);
  assert.match(blocked.output, /bg-done/);
  assert.match(blocked.output, /"running": false/);
  reg.killAll();
});

test('P1-6: TaskStop kills a long runner; Bash run_in_background integration', async () => {
  const reg = new BackgroundRegistry();
  const ctx = { background: reg, cwd: tmpdir() };
  const longCmd = `"${process.execPath}" -e "setTimeout(()=>{}, 60000)"`;
  const started = await BashTool.execute({ command: longCmd, run_in_background: true }, ctx);
  assert.match(started.output, /已后台启动 task_/);
  const taskId = started.output.match(/task_[\w]+/)[0];
  const stopped = await TaskStopTool.execute({ task_id: taskId }, ctx);
  assert.equal(stopped.ok, true);
  assert.match(stopped.output, /stopped/);
  // killed task is removed from the registry
  assert.equal(reg.get(taskId), undefined);
  reg.killAll();
});

test('P1-6: timeout caps and exit cleanup kill stragglers', async () => {
  const reg = new BackgroundRegistry();
  const t = reg.start(`"${process.execPath}" -e "setTimeout(()=>{}, 60000)"`, { cwd: tmpdir(), timeout: 1500 });
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(t.done, true, 'timeout SIGKILLs the task');
  const before = reg.list().length;
  reg.start(`"${process.execPath}" -e "setTimeout(()=>{}, 60000)"`, { cwd: tmpdir(), timeout: 60_000 });
  reg.killAll();
  assert.equal(reg.list().length, 0, 'killAll leaves no orphans');
  assert.ok(before >= 0);
});
