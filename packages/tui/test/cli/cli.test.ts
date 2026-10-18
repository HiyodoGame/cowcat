import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { COMMANDS, EXIT, parseResponse, runCli } from '../../src/index.js';

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
    stderr: (line) => err.push(line),
  });
  return { code, out, err };
}

test('--help lists every command in the table and marks the ones that cannot work yet', async () => {
  const run = await cli(['--help']);
  assert.equal(run.code, EXIT.ok);
  const text = run.out.join('\n');
  for (const command of COMMANDS) {
    assert.ok(text.includes(command.usage), `${command.name} is missing from the help text`);
  }
  // A help screen that lists an unwired verb as if it worked is the same lie as a host
  // that answers an empty success.
  assert.match(text, /尚未可用/);
});

test('-h and --version behave, and the version is a real version', async () => {
  const short = await cli(['-h']);
  assert.equal(short.code, EXIT.ok);
  assert.ok(short.out.join('\n').includes('cowcat'));

  const run = await cli(['--version']);
  assert.equal(run.code, EXIT.ok);
  assert.match(run.out.join('\n').trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown verb is a usage error, and says what exists', async () => {
  const run = await cli(['pause']);
  assert.equal(run.code, EXIT.usage);
  const err = run.err.join('\n');
  assert.match(err, /未知命令 "pause"/);
  assert.match(err, /serve/);
  assert.match(err, /--help/);
});

test('missing or extra arguments are usage errors, checked before anything runs', async () => {
  const noPrompt = await cli(['run']);
  assert.equal(noPrompt.code, EXIT.usage);
  assert.match(noPrompt.err.join('\n'), /用法：cowcat run "<prompt>"/);

  const noId = await cli(['sessions', 'resume']);
  assert.equal(noId.code, EXIT.usage);

  const extra = await cli(['sessions', 'list', 'extra']);
  assert.equal(extra.code, EXIT.usage);

  // A well-formed but unwired verb is a *different* failure: the invocation was fine,
  // the capability is missing. A script has to be able to tell those apart.
  const wired = await cli(['run', 'hello']);
  assert.equal(wired.code, EXIT.failed);
  assert.match(wired.err.join('\n'), /T4a/);
});

test('no arguments means the default verb, and its blocking reason names the task', async () => {
  const run = await cli([]);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /cowcat tui: 尚未接线，需要 T7/);
});

test('the other unwired verbs refuse with their own reasons', async () => {
  for (const [argv, needle] of [
    [['sessions', 'list'], /T4a/],
    [['setup'], /T4a/],
  ] as const) {
    const run = await cli(argv);
    assert.equal(run.code, EXIT.failed);
    assert.match(run.err.join('\n'), needle);
  }
});

test('doctor reports what it can check, and says what it cannot', async () => {
  const run = await cli(['doctor']);
  assert.equal(run.code, EXIT.ok, run.out.join('\n'));
  const text = run.out.join('\n');
  assert.match(text, /node\s+v\d+\.\d+\.\d+（需要 >=26\.4）/);
  assert.match(text, /原生核心\s+@opentui\/core-\w+-\w+\s+ok/);
  assert.match(text, /protocol\s+version \d+/);
  // The absence is stated rather than left to be discovered.
  assert.match(text, /沙箱后端不在这一版 doctor 里/);
});

test('serve is wired: the CLI drives the protocol over injected streams', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const out: string[] = [];
  const done = runCli(['serve'], {
    stdin: input,
    stdoutStream: output,
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  });

  output.setEncoding('utf8');
  const lines: string[] = [];
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  const reply = parseResponse(lines[0] ?? '');
  assert.ok(reply !== null && 'result' in reply, `expected a handshake reply, got ${lines[0] ?? 'nothing'}`);

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} })}\n`);
  assert.equal(await done, EXIT.ok);
});

test('the table has no duplicated verbs and exactly one default', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(COMMANDS.filter((command) => command.isDefault === true).length, 1);
});
