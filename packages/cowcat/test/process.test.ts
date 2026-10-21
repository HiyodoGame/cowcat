import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NodeProcess,
  NodePlatform,
  SandboxUnavailableError,
  defaultSandboxProfile,
  type ProcessPort,
  type ProcessSpec,
  type SandboxCommandResolver,
  type TerminationMethod,
} from '../src/index.js';
import { fakePlatform, posixShell, windowsShell } from './fakes-ports.js';

// The gateway, against real child processes.
//
// Fakes are not usable here on purpose: the properties under test are "the child did
// not see this variable", "the grandchild died with the parent", "the pipes were
// drained before the result was built". A double would answer those questions by
// asserting on itself. The termination PROTOCOL (escalation arithmetic, the 128 and
// ESRCH branches) is faked instead — in terminate.test.ts.

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = here.replace(/packages[/\\]cowcat[/\\]test[/\\]$/, '');

// node is the one executable every CI leg is guaranteed to have, and it can be asked
// to do each of these things without a fixture file on disk.
function node(script: string, args: readonly string[] = []): readonly string[] {
  return [process.execPath, '-e', script, ...args];
}

// The REAL platform, on purpose. A fake that says "linux" while the tests run on
// Windows gives the gateway a strategy the host cannot honour — which is precisely how
// a successful-looking process-group kill that never happened got through the first
// version of these tests.
function port(overrides: { readonly sandboxCommand?: SandboxCommandResolver } = {}): ProcessPort {
  return new NodeProcess({ platform: new NodePlatform(), ...overrides });
}

/** The strategy this host is supposed to use, so a test can assert the pairing. */
function expectedStrategy(): TerminationMethod {
  return new NodePlatform().termination().kind;
}

function spec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    argv: node('process.stdout.write("hi")'),
    cwd: repoRoot,
    env: {},
    sandbox: defaultSandboxProfile(),
    ...overrides,
  };
}

test('a run reports stdout, stderr and the exit code', async () => {
  const result = await port().run(
    spec({
      argv: node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'),
    }),
    new AbortController().signal,
  );

  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.dropped, { stdout: 0, stderr: 0 });
});

test('an optional sink sees the same characters as the result, and a broken sink cannot fail the run (ADR-107)', async () => {
  const signal = new AbortController().signal;
  const seen: { stream: string; text: string }[] = [];
  const result = await port().run(
    spec({ argv: node('process.stdout.write("one\\ntwo\\n"); process.stderr.write("err\\n")') }),
    signal,
    {
      onOutput: (stream, text) => {
        seen.push({ stream, text });
      },
    },
  );

  const joined = (name: string): string =>
    seen
      .filter((chunk) => chunk.stream === name)
      .map((chunk) => chunk.text)
      .join('');
  // Coalescing may split the stream anywhere; the characters, in order, must be the same
  // ones the result reports. This is the property the live view's suffix guarantee rests on.
  assert.equal(joined('stdout'), result.stdout);
  assert.equal(joined('stderr'), result.stderr);

  const broken = await port().run(
    spec({ argv: node('process.stdout.write("still fine")') }),
    signal,
    {
      onOutput: () => {
        throw new Error('renderer bug');
      },
    },
  );
  assert.equal(broken.exitCode, 0);
  assert.equal(broken.stdout, 'still fine');
});

test('the sink sees output while the command is still running (ADR-107)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-sink-'));
  const gate = join(dir, 'go');
  // A handshake instead of a sleep: the child waits for a file the SINK creates. If the
  // sink only fired at close, the gate never appears, the child exits 1 after 5s, and the
  // assertion below fails — no timing assumptions about how fast CI is.
  const script = [
    "process.stdout.write('first\\n')",
    "const fs = require('node:fs')",
    `const gate = ${JSON.stringify(gate)}`,
    'const guard = setTimeout(() => { clearInterval(timer); process.exit(1) }, 5000)',
    'const timer = setInterval(() => {',
    '  if (!fs.existsSync(gate)) return',
    '  clearInterval(timer)',
    '  clearTimeout(guard)',
    '  process.stdout.write("second\\n")',
    '}, 10)',
  ].join(';');

  try {
    const result = await port().run(spec({ argv: node(script) }), new AbortController().signal, {
      onOutput: (stream, text) => {
        if (stream === 'stdout' && text.includes('first')) writeFileSync(gate, '');
      },
    });

    assert.equal(result.exitCode, 0, 'the child only exits cleanly if "first" reached the sink while it was alive');
    assert.equal(result.stdout, 'first\nsecond\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that ended on its own records no termination', async () => {
  const result = await port().run(spec(), new AbortController().signal);

  // An audit that cannot distinguish "exited on its own" from "was killed" cannot
  // answer the only question anyone asks about a crashed run.
  assert.equal(result.termination.requested, false);
  assert.equal(result.termination.reason, 'none');
  assert.equal(result.termination.strategy, 'none');
});

test('light mode strips credential-shaped variables, and names what it stripped', async () => {
  const script = 'process.stdout.write(JSON.stringify({ token: process.env.MY_TOKEN ?? null, keep: process.env.PATH !== undefined }))';
  const result = await port().run(
    spec({
      argv: node(script),
      env: { PATH: 'x', MY_TOKEN: 'swordfish', DATABASE_URL: 'postgres://user:pass@host' },
    }),
    new AbortController().signal,
  );

  const seen = JSON.parse(result.stdout) as { token: string | null; keep: boolean };
  assert.equal(seen.token, null, 'the child must not see it');
  assert.equal(seen.keep, true, 'PATH stays: nothing spawns without it');
  // Names only. The value must not travel any further, so it cannot be in the result.
  assert.deepEqual(result.removedEnv, ['MY_TOKEN']);
  assert.doesNotMatch(result.stdout, /swordfish/);
  assert.equal(result.removedEnv.includes('DATABASE_URL'), false, 'name-based rules only, as documented');
});

test('off mode is the one profile that does not redact', async () => {
  const result = await port().run(
    spec({
      argv: node('process.stdout.write(process.env.MY_TOKEN ?? "")'),
      env: { MY_TOKEN: 'visible' },
      sandbox: defaultSandboxProfile({ mode: 'off' }),
    }),
    new AbortController().signal,
  );

  // Its contract is "run the command as-is", so it is the one case where a caller can
  // legitimately hand over an unredacted environment.
  assert.equal(result.stdout, 'visible');
  assert.deepEqual(result.removedEnv, []);
});

test('system mode redacts too — the coverage the legacy gateway lacked', async () => {
  // An executor stands in for T5, so this test can be about the REDACTION half alone:
  // which env the child ends up with. T5 replaces the resolver; the gateway's redaction
  // step is upstream of it and must not change.
  const withSandbox = new NodeProcess({
    platform: new NodePlatform(),
    sandboxCommand: (requested) => ({ argv: requested.argv, backend: 'bwrap', limitations: [] }),
  });

  const result = await withSandbox.run(
    spec({
      argv: node('process.stdout.write(process.env.MY_SECRET ?? "")'),
      env: { MY_SECRET: 'hunter2' },
      sandbox: defaultSandboxProfile({ mode: 'system' }),
    }),
    new AbortController().signal,
  );

  // In the legacy code `sandboxEnv()` returned the environment untouched unless the
  // mode was `light`, so the STRICT tier was the leaky one (research/p2-ports.md §4.2).
  assert.equal(result.stdout, '');
  assert.deepEqual(result.removedEnv, ['MY_SECRET']);
});

test('an explicit deny entry is honoured, and an invalid one is reported', async () => {
  const result = await port().run(
    spec({
      argv: node('process.stdout.write(String(process.env.DATABASE_URL))'),
      env: { DATABASE_URL: 'postgres://user:pass@host' },
      sandbox: defaultSandboxProfile({ env: { deny: ['DATABASE_URL', '/([unclosed/'] } }),
    }),
    new AbortController().signal,
  );

  assert.equal(result.stdout, 'undefined');
  assert.deepEqual(result.removedEnv, ['DATABASE_URL']);
  // A typo in configuration has to be visible, the same way an unsupported glob is.
  assert.deepEqual(result.ignoredDeny, ['/([unclosed/']);
});

test('output is capped to the tail, and the dropped count is exact', async () => {
  const result = await port().run(
    spec({
      argv: node('process.stdout.write("x".repeat(5000) + "END")'),
      outputCap: 10,
    }),
    new AbortController().signal,
  );

  // Exactly ten characters — cap is characters, not chunks: 'END' plus seven x's.
  assert.equal(result.stdout, 'xxxxxxxEND');
  assert.equal(result.stdout.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.dropped.stdout, 5003 - result.stdout.length);
  assert.equal(result.dropped.stderr, 0);
  // The identity the count exists for: what you see plus what went is everything there was.
  assert.equal(result.dropped.stdout + result.stdout.length, 5003);
});

test('a child that exits without reading stdin does not crash the run', async () => {
  // Measured on macOS: writing to a pipe whose reader is already gone raises EPIPE
  // synchronously, and Node reports a child pipe error as an UNCAUGHT exception unless
  // something listens. Unhandled, it took down the whole test process rather than
  // failing one assertion — so this test is worth its line.
  const result = await port().run(
    spec({
      argv: node('process.exit(0)', ['never-read']),
      stdin: 'this input is going nowhere',
    }),
    new AbortController().signal,
  );

  assert.equal(result.exitCode, 0);
});

test('a child that ignores stdin and keeps running still gets its input', async () => {
  // The other half: the error listener must not swallow the write itself.
  const result = await port().run(
    spec({
      argv: node('setTimeout(() => { process.stdout.write(String(process.env.FROM_STDIN ?? "none")) }, 200)'),
      stdin: 'unused',
      env: { FROM_STDIN: 'inherited' },
    }),
    new AbortController().signal,
  );

  assert.equal(result.stdout, 'inherited');
});

test('stdin is delivered and closed', async () => {
  const result = await port().run(
    spec({
      argv: node('let d=""; process.stdin.on("data", (c) => { d += c; }); process.stdin.on("end", () => process.stdout.write(d.toUpperCase()))'),
      stdin: 'shout',
    }),
    new AbortController().signal,
  );

  assert.equal(result.stdout, 'SHOUT');
});

test('a child that cannot be started is a rejection, not a result', async () => {
  await assert.rejects(
    port().run(spec({ argv: ['cowcat-no-such-executable-here'] }), new AbortController().signal),
    /ENOENT|cannot find/i,
  );
});

test('an empty argv is refused with a message that names the problem', async () => {
  // spawn's own error for this says nothing about which run was at fault.
  await assert.rejects(port().run(spec({ argv: [] }), new AbortController().signal), /argv is empty/);
});

test('the grandchild dies with the parent, not just the direct child', async (t) => {
  // The regression this whole task exists for. The legacy gateway had two real orphan
  // bugs, and both were "we killed the child and its grandchildren kept running".
  // Three levels deep on purpose: a shim shape (wrapper → node → node) is where the old
  // single-process kills leaked.
  const directory = mkdtempSync(join(tmpdir(), 'cowcat-tree-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const pidFile = join(directory, 'grandchild.pid');
  // The grandchild records its own pid, then outlives its parent on purpose.
  const grandchild = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 20_000)';

  const result = await port().run(
    spec({
      argv: node(
        `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: "ignore" }); setTimeout(() => {}, 20_000)`,
      ),
      timeoutMs: 1_500,
    }),
    new AbortController().signal,
  );

  assert.equal(result.termination.requested, true);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  // Give the OS a moment to finish tearing the tree down before asking.
  await delay(700);
  assert.equal(processAlive(pid), false, `grandchild ${String(pid)} outlived the tree kill`);
});

/** Whether a pid is still running. `kill(0)` is the portable liveness probe. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('the timeout path uses the platform\'s own strategy, with no silent fallback', async () => {
  // The end-to-end version of what terminate.test.ts asserts with fakes — and the test
  // that caught a Windows host reporting a successful process-group kill that had not
  // happened (`kill(-pid)` is meaningless there and its failure looks like ESRCH).
  const result = await port().run(
    spec({ argv: node('setTimeout(() => {}, 20_000)'), timeoutMs: 500 }),
    new AbortController().signal,
  );

  assert.equal(result.termination.strategy, expectedStrategy());
  assert.equal(result.termination.fallbackUsed, false, 'the platform strategy was available');
  assert.equal(result.termination.residuePossible, false);
  assert.ok(result.exitCode !== 0 || result.signal !== null, 'the child did not exit on its own');
});

test('a timeout is a result, not a rejection', async () => {
  // The caller has to report to the model that the command was cut off, which it cannot
  // do if the run rejected.
  const result = await port().run(
    spec({ argv: node('setTimeout(() => {}, 20_000)'), timeoutMs: 400 }),
    new AbortController().signal,
  );

  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.reason, 'timeout');
});

test('an aborted run is terminated through the same path as a timeout', async () => {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, 200);
  const result = await port().run(spec({ argv: node('setTimeout(() => {}, 60_000)') }), controller.signal);

  // ADR-014: one terminate(), not two. The reason distinguishes them; the path is shared.
  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.reason, 'cancel');
});

test('an already-aborted signal never starts a process', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await port().run(spec({ argv: node('require("fs").writeFileSync("cowcat-should-not-exist", "x")') }), controller.signal);

  // Starting a process in order to kill it is the other half of the same mistake.
  assert.equal(result.exitCode, null);
  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.reason, 'cancel');
  assert.equal(result.termination.strategy, 'none', 'nothing ran, so nothing was terminated');
});

test('output produced before a kill is still reported', async () => {
  const result = await port().run(
    spec({
      argv: node('process.stdout.write("partial work\\n"); setTimeout(() => {}, 60_000)'),
      timeoutMs: 500,
    }),
    new AbortController().signal,
  );

  // The pipes must be drained before the result is built, or a killed run reports the
  // output it had already produced as empty — which reads as "it never ran".
  assert.match(result.stdout, /partial work/);
});

test('a timeout and an abort racing each other still terminate once', async () => {
  const controller = new AbortController();
  const run = port().run(spec({ argv: node('setTimeout(() => {}, 60_000)'), timeoutMs: 250 }), controller.signal);
  setTimeout(() => {
    controller.abort();
  }, 250);

  const result = await run;

  // The record can only name one reason because only one terminate() ran; whichever
  // fired first is the honest answer.
  assert.equal(result.termination.requested, true);
  assert.ok(['timeout', 'cancel'].includes(result.termination.reason));
});

test('system mode without an executor is refused, never downgraded', async () => {
  const refused = new NodeProcess({ platform: fakePlatform({ shell: posixShell() }) });

  await assert.rejects(refused.run(spec({ sandbox: defaultSandboxProfile({ mode: 'system' }) }), new AbortController().signal), (error: unknown) => {
    if (!(error instanceof SandboxUnavailableError)) return false;
    assert.equal(error.mode, 'system');
    assert.equal(error.reason, 'not-implemented');
    // Never "the sandbox is on": the whole point of ADR-016 is that a run that lost
    // its isolation must say so, with somewhere else to go.
    assert.doesNotMatch(error.message, /已启用|enabled/);
    assert.ok(error.alternatives.some((alternative) => /light/i.test(alternative)));
    return true;
  });
});

test('on Windows the refusal names WSL2 rather than blaming the tier', async () => {
  const refused = new NodeProcess({ platform: fakePlatform({ platform: 'windows', shell: windowsShell() }) });

  await assert.rejects(
    refused.run(spec({ sandbox: defaultSandboxProfile({ mode: 'system' }) }), new AbortController().signal),
    (error: unknown) => {
      if (!(error instanceof SandboxUnavailableError)) return false;
      assert.equal(error.reason, 'unsupported-platform');
      assert.ok(error.alternatives.some((alternative) => /WSL2/i.test(alternative)));
      return true;
    },
  );
});

test('an injected executor is what actually gets run', async () => {
  // T5's seam, exercised now so the wiring is known to work rather than assumed:
  // the gateway must spawn the argv the resolver returned, not the requested one.
  const withSandbox = new NodeProcess({
    platform: fakePlatform({ shell: posixShell() }),
    sandboxCommand: () => ({ argv: node('process.stdout.write("wrapped")'), backend: 'bwrap', limitations: [] }),
  });

  const result = await withSandbox.run(spec({ sandbox: defaultSandboxProfile({ mode: 'system' }) }), new AbortController().signal);

  assert.equal(result.stdout, 'wrapped');
});