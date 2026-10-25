import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderHelp } from '../src/cli/help.js';
import { runCli, type CliOptions } from '../src/cli/run.js';

function capture(): { readonly options: CliOptions; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

test('global help states the TUI and headless Node floors', () => {
  const help = renderHelp();
  assert.match(help, /默认 TUI 需要 Node >= 26\.4/);
  assert.match(help, /headless \/ run \/ doctor 等命令需要 Node >= 22/);
});

test('tui --help renders command help without starting the TUI', async () => {
  const captured = capture();
  const code = await runCli(['tui', '--help'], captured.options);
  assert.equal(code, 0);
  const output = captured.stdout.join('\n');
  assert.match(output, /cowcat tui/);
  assert.match(output, /--worktree <name>/);
  assert.match(output, /默认 TUI 需要 Node >= 26\.4/);
  assert.match(output, /headless \/ run \/ doctor 等命令需要 Node >= 22/);
  assert.deepEqual(captured.stderr, []);
});

test('help tui is an alias for tui --help', async () => {
  const direct = capture();
  const alias = capture();
  assert.equal(await runCli(['tui', '--help'], direct.options), 0);
  assert.equal(await runCli(['help', 'tui'], alias.options), 0);
  assert.deepEqual(alias.stdout, direct.stdout);
  assert.deepEqual(alias.stderr, []);
});

test('doctor --help does not run environment diagnostics', async () => {
  const captured = capture();
  const code = await runCli(['doctor', '--help'], captured.options);
  assert.equal(code, 0);
  assert.match(captured.stdout.join('\n'), /cowcat doctor/);
  assert.doesNotMatch(captured.stdout.join('\n'), /doctor: 通过|protocol\s+version/);
});

test('run --help takes precedence over the required prompt', async () => {
  const captured = capture();
  const code = await runCli(['run', '--help'], captured.options);
  assert.equal(code, 0);
  assert.match(captured.stdout.join('\n'), /cowcat run/);
  assert.doesNotMatch(captured.stderr.join('\n'), /参数不对/);
});

test('an unknown command still returns usage even when help is requested', async () => {
  const captured = capture();
  const code = await runCli(['not-a-command', '--help'], captured.options);
  assert.equal(code, 2);
  assert.match(captured.stderr.join('\n'), /未知命令/);
});
