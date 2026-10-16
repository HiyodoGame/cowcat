import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockPort, LockHeldError } from '../src/index.js';

// The lock exists to keep two *processes* out of one session, so this is the only
// file in the suite that spawns. Everything else about `packages/cowcat` staying
// cheap still holds (see the job comment in .github/workflows/ci.yml).
const RACERS = 8;
const GO = 'GO';
const RELEASE = 'RELEASE';
// The children are plain node processes, so they import the built adapter (pretest
// builds before the suite runs) by URL rather than a bare specifier.
const ADAPTER_URL = new URL('../src/adapters/node.js', import.meta.url).href;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

function lockPathOf(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.jsonl.lock`);
}

// Runs in the child. Two phases so no step depends on how long anything takes:
// every racer attempts while the winner is holding, and the winner only releases
// after the parent has seen all of the attempts. A fixed sleep would let a slow
// racer attempt after the winner released and then "win" too.
const RACER = `
const payload = JSON.parse(process.env.COWCAT_LOCK_RACER);
const fs = await import('node:fs');
const path = await import('node:path');
const { FileLockPort } = await import(payload.adapterUrl);

const say = (line) => process.stdout.write(line + '\\n');
const waitFor = async (name, ms) => {
  const file = path.join(payload.dir, name);
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10));
  }
};

const port = new FileLockPort(payload.dir);

if (payload.mode === 'hold') {
  await port.acquire(payload.sessionId);
  say('ACQUIRED');
  await new Promise((done) => setTimeout(done, 60000));
} else {
  say('READY');
  await waitFor(${JSON.stringify(GO)}, 15000);
  try {
    const lock = await port.acquire(payload.sessionId);
    say('ACQUIRED');
    await waitFor(${JSON.stringify(RELEASE)}, 15000);
    await lock.release();
  } catch (error) {
    if (error && error.name === 'LockHeldError') say('REFUSED ' + String(error.pid));
    else {
      process.stderr.write('ERROR ' + String(error && error.message) + '\\n');
      process.exit(1);
    }
  }
}
`;

interface RacerExit {
  readonly code: number | null;
  readonly stderr: string;
}

interface Racer {
  readonly pid: number | undefined;
  /** Resolves on the first output line, so the parent can hand out the next phase. */
  readonly started: Promise<void>;
  /** Resolves on the ACQUIRED / REFUSED / ERROR line. */
  readonly result: Promise<string>;
  readonly done: Promise<RacerExit>;
}

function startRacer(payload: Record<string, unknown>): Racer {
  const child = spawn(process.execPath, ['--input-type=module', '-e', RACER], {
    env: { ...process.env, COWCAT_LOCK_RACER: JSON.stringify(payload) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  const lines: string[] = [];
  // Defaults are no-ops so the handlers below never have to check for undefined.
  let markStarted: () => void = () => undefined;
  let markResult: (line: string) => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const result = new Promise<string>((resolve) => {
    markResult = resolve;
  });

  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.length === 0) continue;
      lines.push(line);
      markStarted();
      if (/^(ACQUIRED|REFUSED|ERROR)/.test(line)) markResult(line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const done = new Promise<RacerExit>((resolve) => {
    child.on('close', (code) => {
      // Never leave a caller waiting on a result the child did not print.
      markResult(lines.at(-1) ?? `(no output, exit ${String(code)})`);
      resolve({ code, stderr });
    });
  });
  child.on('error', () => {
    markResult('(failed to start)');
  });

  return { pid: child.pid, started, result, done };
}

function summarise(racers: readonly Racer[], results: readonly string[]): string {
  return results.map((line, index) => `racer ${String(index)}: ${line} (pid ${String(racers[index]?.pid)})`).join('\n');
}

test('only one of several racing processes can hold a session', async () => {
  const dir = tempDir();
  try {
    const racers = Array.from({ length: RACERS }, () =>
      startRacer({ dir, sessionId: 'sess_race', mode: 'race', adapterUrl: ADAPTER_URL }),
    );
    // Every racer is up and waiting before the race opens, so the contention is real.
    await Promise.all(racers.map((racer) => racer.started));
    writeFileSync(join(dir, GO), '');

    const results = await Promise.all(racers.map((racer) => racer.result));
    const acquired = results.filter((line) => line === 'ACQUIRED');
    const refused = results.filter((line) => line.startsWith('REFUSED'));
    const detail = summarise(racers, results);

    assert.equal(acquired.length, 1, `expected exactly one winner\n${detail}`);
    assert.equal(refused.length, RACERS - 1, `expected every other racer to be refused\n${detail}`);

    writeFileSync(join(dir, RELEASE), '');
    const exits = await Promise.all(racers.map((racer) => racer.done));
    assert.deepEqual(
      exits.map((exit) => exit.code),
      Array.from({ length: RACERS }, () => 0),
      exits.map((exit, index) => `racer ${String(index)}: ${exit.stderr}`).join('\n'),
    );
    assert.equal(existsSync(lockPathOf(dir, 'sess_race')), false, 'the winner should have released');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function acquireOutcome(dir: string, sessionId: string): Promise<LockHeldError | null> {
  try {
    await new FileLockPort(dir).acquire(sessionId);
    return null;
  } catch (error) {
    assert.ok(error instanceof LockHeldError);
    return error;
  }
}

test('a hard-killed holder leaves a lock that reports the writer is gone', async () => {
  const dir = tempDir();
  try {
    const holder = startRacer({ dir, sessionId: 'sess_killed', mode: 'hold', adapterUrl: ADAPTER_URL });
    assert.equal(await holder.result, 'ACQUIRED');
    const pid = holder.pid;
    assert.ok(pid !== undefined, 'the holder should have a pid');

    process.kill(pid, 'SIGKILL');
    await holder.done;

    // The pid can take a moment to disappear on some platforms, so wait for the
    // classification instead of asserting on a race.
    const deadline = Date.now() + 2_000;
    let outcome = await acquireOutcome(dir, 'sess_killed');
    while (outcome !== null && !/is gone/.test(outcome.guidance) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
      outcome = await acquireOutcome(dir, 'sess_killed');
    }

    assert.ok(outcome !== null, 'a lock left by a dead writer must not be claimable');
    assert.equal(outcome.pid, pid);
    assert.match(outcome.guidance, /is gone/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
