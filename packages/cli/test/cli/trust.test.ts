import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { EXIT, runCli } from '../../src/index.js';

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function cli(argv: readonly string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => out.push(line),
    write: (text) => out.push(text),
    stderr: (line) => err.push(line),
  });
  return { code, out, err };
}

function isolatedHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-trust-'));
  const previous = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function workspace(t: TestContext, agents = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-trust-target-'));
  if (agents) writeFileSync(join(dir, 'AGENTS.md'), '# 约定\n\n跑测试之前先构建。\n');
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function trusted(home: string): readonly string[] {
  const raw = JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')) as { trusted?: unknown };
  return Array.isArray(raw.trusted) ? raw.trusted.filter((entry): entry is string => typeof entry === 'string') : [];
}

test('trust records the directory and reports the instruction files it unlocks', async (t) => {
  const home = isolatedHome(t);
  const target = workspace(t, true);

  const run = await cli(['trust', target]);
  assert.equal(run.code, EXIT.ok);
  assert.match(run.out.join('\n'), /已信任/u);
  assert.match(run.out.join('\n'), /AGENTS\.md/u);
  assert.equal(trusted(home).length, 1);
  assert.ok(existsSync(join(home, 'trust.json')));
});

test('trust is idempotent by directory identity', async (t) => {
  const home = isolatedHome(t);
  const target = workspace(t);

  assert.equal((await cli(['trust', target])).code, EXIT.ok);
  const again = await cli(['trust', target]);
  assert.equal(again.code, EXIT.ok);
  assert.match(again.out.join('\n'), /已经信任过/u);
  assert.equal(trusted(home).length, 1);
});

test('trust --list shows what is recorded and trust --remove takes it back', async (t) => {
  const home = isolatedHome(t);
  const target = workspace(t);

  const empty = await cli(['trust', '--list']);
  assert.equal(empty.code, EXIT.ok);
  assert.match(empty.out.join('\n'), /还没有信任任何目录/u);

  assert.equal((await cli(['trust', target])).code, EXIT.ok);
  const listed = await cli(['trust', '--list']);
  assert.equal(listed.code, EXIT.ok);
  assert.equal(listed.out.length, 1);
  assert.match(listed.out[0] ?? '', /cowcat-trust-target-/u);
  assert.equal(listed.out[0], trusted(home)[0]);

  const removed = await cli(['trust', target, '--remove']);
  assert.equal(removed.code, EXIT.ok);
  assert.match(removed.out.join('\n'), /已撤销信任/u);
  assert.deepEqual(trusted(home), []);
});

test('trust --list and --remove together is a usage error, not a guess', async (t) => {
  isolatedHome(t);
  const run = await cli(['trust', '--list', '--remove']);
  assert.equal(run.code, EXIT.usage);
  assert.match(run.err.join('\n'), /只能选一个/u);
});

test('trust reports the global instruction file path even outside a repository', async (t) => {
  const home = isolatedHome(t);
  const target = workspace(t);
  writeFileSync(join(home, 'AGENTS.md'), '# 全局约定\n');

  const run = await cli(['trust', target]);
  assert.equal(run.code, EXIT.ok);
  assert.match(run.out.join('\n'), /AGENTS\.md/u);
  assert.ok(run.out.some((line) => line.trim() === join(home, 'AGENTS.md')));
});
