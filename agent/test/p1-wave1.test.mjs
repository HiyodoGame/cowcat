// P1 wave 1: memory system (multi-level load, dedup, truncation, /memory add,
// disable switch) + permission rules engine (parse/validate, priorities,
// Bash prefix, /permissions persistence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectMemories, memorySection, memoryPathFor, ensureMemoryFile, appendMemory,
  memoryDisabled, MEMORY_FILE_LIMIT,
} from '../src/memory.js';
import { validateRule, loadRules, matchRule, saveRuleColumn } from '../src/perrules.js';
import { Permissions } from '../src/permissions.js';

function setupHome() {
  const saved = process.env.COWCAT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    home,
    restore: () => { if (saved === undefined) delete process.env.COWCAT_HOME; else process.env.COWCAT_HOME = saved; },
  };
}

// --- P1-1 memory -------------------------------------------------------------

test('P1-1: collectMemories gathers user/project/rules in order, dedups, truncates', () => {
  const { home, restore } = setupHome();
  try {
    const root = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    const sub = join(root, 'app');
    mkdirSync(join(root, '.cowcat', 'rules'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(home, 'CLAUDE.md'), 'user level memory');
    writeFileSync(join(root, 'CLAUDE.md'), 'root project memory');
    writeFileSync(join(root, '.cowcat', 'CLAUDE.md'), 'root .cowcat memory');
    writeFileSync(join(root, '.cowcat', 'rules', 'a-lint.md'), 'lint rules');
    writeFileSync(join(root, '.cowcat', 'rules', 'b-style.md'), 'style rules');
    writeFileSync(join(sub, 'CLAUDE.md'), 'nearest app memory');

    // without dedup: user first, then nearest-first project walk
    let mem = collectMemories({ cwd: sub });
    assert.deepEqual(mem.map((m) => m.level), ['user', 'project', 'project', 'project', 'project-rule', 'project-rule']);
    assert.equal(mem[1].content, 'nearest app memory');
    assert.equal(mem[2].content, 'root project memory');
    assert.equal(mem[3].content, 'root .cowcat memory');
    assert.deepEqual(mem.slice(4).map((m) => m.content), ['lint rules', 'style rules'], 'rules sorted by filename');

    // dedup: the nearest project CLAUDE.md already injected via project.js
    mem = collectMemories({ cwd: sub, skipPaths: new Set([mem[1].path]) });
    assert.equal(mem.filter((m) => m.content === 'nearest app memory').length, 0);

    // truncation
    writeFileSync(join(sub, 'CLAUDE.md'), 'nearest app memory\n' + 'x'.repeat(MEMORY_FILE_LIMIT + 500));
    mem = collectMemories({ cwd: sub, skipPaths: new Set(), env: {} });
    const big = mem.find((m) => m.path === join(sub, 'CLAUDE.md'));
    assert.ok(big.content.endsWith('[truncated]'));
    assert.ok(big.content.length < MEMORY_FILE_LIMIT + 100);

    // section header carries level + path
    assert.match(memorySection(mem[0]), /# Memory \(user: /);

    // disable switch
    assert.equal(memoryDisabled({ COWCAT_DISABLE_MEMORY: '1' }), true);
    assert.deepEqual(collectMemories({ cwd: sub, env: { COWCAT_DISABLE_MEMORY: '1' } }), []);
  } finally {
    restore();
  }
});

test('P1-1: /memory path helpers, template creation, and append (the /memory add path)', () => {
  const { home, restore } = setupHome();
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'cowcat-proj-'));
    const userPath = memoryPathFor('user', cwd);
    assert.ok(userPath.startsWith(home));
    const projPath = memoryPathFor('project', cwd);
    assert.equal(projPath, join(cwd, 'CLAUDE.md'));

    assert.equal(existsSync(projPath), false);
    assert.equal(ensureMemoryFile(projPath), true, 'creates with template');
    assert.match(readFileSync(projPath, 'utf8'), /durable instructions/i);
    assert.equal(ensureMemoryFile(projPath), false);

    appendMemory(projPath, '- never touch generated/');
    const content = readFileSync(projPath, 'utf8');
    assert.ok(content.includes('- never touch generated/'));
  } finally {
    restore();
  }
});

// --- P1-2 permission rules ----------------------------------------------------

const KNOWN = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

test('P1-2: rule parser validates syntax with Chinese errors', () => {
  assert.deepEqual(validateRule('Bash', KNOWN).rule, { tool: 'Bash', pattern: null, prefix: false, raw: 'Bash' });
  assert.equal(validateRule('Bash(npm run test)', KNOWN).rule.pattern, 'npm run test');
  const prefix = validateRule('Bash(npm run test:*)', KNOWN).rule;
  assert.equal(prefix.prefix, true);
  assert.equal(prefix.pattern, 'npm run test');

  assert.match(validateRule('Fly(spell)', KNOWN).error, /未注册/);
  assert.match(validateRule('Bash(npm test', KNOWN).error, /括号不配对/);
  assert.match(validateRule('Bash()', KNOWN).error, /模式为空/);
  assert.match(validateRule('Bash(npm * test)', KNOWN).error, /只能以/);
});

test('P1-2: loadRules skips bad rules with positional warnings, startup survives', () => {
  const { warnings, deny, allow } = loadRules({ permissions: { deny: ['Bash(rm -rf:*)', 'Bad(', 'Nope(x)'], allow: ['Read'] } }, KNOWN);
  assert.equal(deny.length, 1);
  assert.equal(allow.length, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /deny 第 2 条/);
  assert.match(warnings[1], /deny 第 3 条/);
});

test('P1-2: priority deny > ask > allow > default; yolo overrides everything', () => {
  const perms = new Permissions('default');
  perms.setRules(loadRules({ permissions: {
    allow: ['Bash', 'Edit(src/**)'],
    ask: ['Bash(npm publish)'],
    deny: ['Bash(npm publish --force)', 'Edit(src/secure/**)'],
  } }, KNOWN));

  assert.equal(perms.decide('Bash', { command: 'npm install' }), 'allow');
  assert.equal(perms.decide('Bash', { command: 'npm publish' }), 'ask');
  assert.equal(perms.decide('Bash', { command: 'npm publish --force' }), 'deny');
  assert.match(perms.deniedBy('Bash', { command: 'npm publish --force' }).raw, /--force/);
  assert.equal(perms.decide('Edit', { file_path: 'src/app/index.js' }), 'allow');
  assert.equal(perms.decide('Edit', { file_path: 'src/secure/vault.js' }), 'deny', 'deny beats allow');
  assert.equal(perms.decide('Write', { file_path: 'x.txt' }), 'ask', 'default: ask');

  const yolo = new Permissions('yolo');
  yolo.setRules(loadRules({ permissions: { deny: ['Bash'] } }, KNOWN));
  assert.equal(yolo.decide('Bash', { command: 'rm -rf /' }), 'allow', 'rules never apply in yolo');
});

test('P1-2: Bash prefix matching is command-string based', () => {
  const rule = validateRule('Bash(npm run test:*)', KNOWN).rule;
  assert.ok(matchRule(rule, 'Bash', { command: 'npm run test' }));
  assert.ok(matchRule(rule, 'Bash', { command: 'npm run test:unit' }));
  assert.ok(!matchRule(rule, 'Bash', { command: 'npm run testing' }), 'prefix boundary at the colon');
  assert.ok(!matchRule(rule, 'Bash', { command: 'npm run lint' }));
  const exact = validateRule('Bash(npm run test)', KNOWN).rule;
  assert.ok(matchRule(exact, 'Bash', { command: 'npm run test' }));
  assert.ok(!matchRule(exact, 'Bash', { command: 'npm run test:unit' }));
});

test('P1-2: /permissions persistence round-trip preserves other config fields', () => {
  const { home, restore } = setupHome();
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ installId: 'keep-me', model: 'kimi-for-coding' }));
    saveRuleColumn('allow', ['Bash(npm run test:*)', 'Read']);
    saveRuleColumn('deny', ['Bash(rm -rf:*)']);
    // remove path: read back, drop #1, save
    const onDisk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(onDisk.installId, 'keep-me');
    assert.deepEqual(onDisk.permissions.allow, ['Bash(npm run test:*)', 'Read']);
    const list = onDisk.permissions.allow.filter((_, i) => i !== 0);
    saveRuleColumn('allow', list);
    const after = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.deepEqual(after.permissions.allow, ['Read']);
    assert.equal(after.permissions.deny.length, 1);

    // hot reload semantics: reload from cfg applies immediately
    const perms = new Permissions('default');
    perms.setRules(loadRules(after, KNOWN));
    assert.equal(perms.decide('Bash', { command: 'npm run test:unit' }), 'ask', 'removed rule no longer allows');
    assert.equal(perms.decide('Bash', { command: 'rm -rf /x' }), 'deny');
  } finally {
    restore();
  }
});
