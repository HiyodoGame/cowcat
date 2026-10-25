import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDoctor } from '../src/cli/doctor.js';
import type { CommandContext } from '../src/cli/spec.js';
import { defaultEntryProblem, meetsNodeFloor } from '../src/cli/runtime.js';

const RENDERER_FLOOR = { major: 26, minor: 4 } as const;

test('Node floor comparison accepts only versions at or above the boundary', () => {
  assert.equal(meetsNodeFloor('22.0.0', { major: 22, minor: 0 }), true);
  assert.equal(meetsNodeFloor('25.9.0', RENDERER_FLOOR), false);
  assert.equal(meetsNodeFloor('26.3.9', RENDERER_FLOOR), false);
  assert.equal(meetsNodeFloor('26.4.0', RENDERER_FLOOR), true);
  assert.equal(meetsNodeFloor('27.0.0', RENDERER_FLOOR), true);
});

test('default entry problem names the TUI requirement only when it is unmet', () => {
  assert.match(defaultEntryProblem('26.3.9') ?? '', /默认 TUI.*26\.4/);
  assert.equal(defaultEntryProblem('26.4.0'), null);
  assert.equal(defaultEntryProblem('27.0.0'), null);
});

test('doctor fails default-entry readiness below Node 26.4 and passes it at the floor', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-runtime-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-runtime-cwd-'));
  const previousCwd = process.cwd();
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({ HOME: home, USERPROFILE: home, COWCAT_HOME: join(home, 'state') })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  process.chdir(cwd);
  t.after(() => {
    process.chdir(previousCwd);
    for (const [name, value] of previous) {
      if (value === undefined) {
        if (name === 'HOME') delete process.env.HOME;
        else if (name === 'USERPROFILE') delete process.env.USERPROFILE;
        else if (name === 'COWCAT_HOME') delete process.env.COWCAT_HOME;
      } else {
        process.env[name] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const old = captureDoctor();
  const oldCode = await runDoctor(old.context, '24.18.0');
  assert.equal(oldCode, 1);
  assert.match(old.stdout.join('\n'), /默认入口.*FAIL/);
  assert.match(old.stdout.join('\n'), /serve \/ run.*Node >= 22/);

  const supported = captureDoctor();
  const supportedCode = await runDoctor(supported.context, '26.4.0');
  assert.equal(supportedCode, 0, supported.stdout.join('\n'));
  assert.doesNotMatch(supported.stdout.join('\n'), /默认入口.*FAIL/);
});

function captureDoctor(): { readonly context: CommandContext; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    context: {
      args: [],
      flags: {},
      stdout: (line) => stdout.push(line),
      write: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    },
  };
}
