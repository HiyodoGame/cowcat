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
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-setup-'));
  const previous = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('setup --migrate writes a v2 config, keeps the key out, and backs the v1 file up', async (t) => {
  const home = isolatedHome(t);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(
      {
        model: 'zai-coding-plan/glm-5.3-flash',
        providers: { 'zai-coding-plan': { apiKey: 'sk-must-not-be-copied' } },
        sandbox: 'off',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(home, 'mcp.json'),
    JSON.stringify({ mcpServers: { fake: { command: 'node', args: ['server.js'], env: { SECRET: 'x' } } } }, null, 2),
  );

  const run = await cli(['setup', '--migrate']);
  assert.equal(run.code, EXIT.ok);

  const config = readConfig(home);
  const model = asRecord(config['model']);
  assert.equal(model['preset'], 'zai-coding-plan/glm-5.3-flash');
  const providers = asRecord(model['providers']);
  assert.deepEqual(asRecord(providers['zai-coding-plan']), { apiKeyEnv: 'ZHIPU_API_KEY' });
  assert.deepEqual(asRecord(config['sandbox']), { mode: 'off' });
  const servers = asRecord(asRecord(config['mcp'])['servers']);
  assert.deepEqual(asRecord(servers['fake']), { command: 'node', args: ['server.js'] });

  const raw = readFileSync(join(home, 'config.json'), 'utf8');
  assert.ok(!raw.includes('sk-must-not-be-copied'), 'the inline key must not be written');
  assert.ok(!raw.includes('SECRET'), 'mcp env must not be copied');
  assert.ok(existsSync(join(home, 'config.json.bak')));
  assert.match(run.out.join('\n'), /ZHIPU_API_KEY/u);
});

test('setup --preset --print shows the document without writing it', async (t) => {
  const home = isolatedHome(t);
  const run = await cli(['setup', '--preset', 'deepseek/deepseek-flash', '--print']);
  assert.equal(run.code, EXIT.ok);
  assert.equal(existsSync(join(home, 'config.json')), false);
  const printed = JSON.parse(run.out.join('\n')) as Record<string, unknown>;
  const model = asRecord(printed['model']);
  assert.equal(model['preset'], 'deepseek/deepseek-flash');
});

test('setup refuses to overwrite an existing config without --force, and backs it up with --force', async (t) => {
  const home = isolatedHome(t);
  assert.equal((await cli(['setup', '--preset', 'deepseek/deepseek-flash'])).code, EXIT.ok);
  const first = readConfig(home);

  const refused = await cli(['setup', '--preset', 'anthropic/claude-sonnet-5-5']);
  assert.equal(refused.code, EXIT.failed);
  assert.match(refused.err.join('\n'), /--force/u);
  assert.deepEqual(readConfig(home), first);

  const forced = await cli(['setup', '--preset', 'anthropic/claude-sonnet-5-5', '--force']);
  assert.equal(forced.code, EXIT.ok);
  assert.equal(asRecord(readConfig(home)['model'])['preset'], 'anthropic/claude-sonnet-5-5');
  assert.ok(existsSync(join(home, 'config.json.bak')));
});

test('setup rejects an unknown preset and says what exists', async (t) => {
  isolatedHome(t);
  const run = await cli(['setup', '--preset', 'nobody/nothing']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /未知 preset/u);
  assert.match(run.err.join('\n'), /deepseek\/deepseek-flash/u);
});

test('setup --migrate without a v1 file is a plain refusal', async (t) => {
  isolatedHome(t);
  const run = await cli(['setup', '--migrate']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /没有找到 v1 配置/u);
});
