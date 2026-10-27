import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ADR-059 ①: exactly one test spawns a process, and it answers the question no in-process
 * test can — does the built entry start, talk over real pipes, and exit with a code.
 * Everything else about the protocol runs over the in-memory transport, where the failure
 * messages are readable.
 *
 * It spawns the real executable (`cowcat serve`), not a test-only entry, so the argv path,
 * the subcommand dispatch, the REAL host (ADR-064) and the process lifecycle are all
 * covered at once. `COWCAT_HOME` points at a temp directory, so the child writes its
 * session log there and never into the developer's own `~/.cowcat`.
 */
const ENTRY = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));
const TIMEOUT_MS = 30_000;

interface Spawned {
  write(request: object): void;
  closeStdin(): void;
  waitForLine(contains: string): Promise<string>;
  readonly exited: Promise<number | null>;
  stop(): void;
}

function start(home: string): Spawned {
  const child = spawn(process.execPath, [ENTRY, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, COWCAT_HOME: home },
  });
  const waiters: { readonly contains: string; readonly resolve: (line: string) => void }[] = [];
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      for (const waiter of [...waiters]) {
        if (line.includes(waiter.contains)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });

  return {
    write: (request) => {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    },
    closeStdin: () => {
      child.stdin.end();
    },
    waitForLine: (contains) =>
      new Promise((resolve) => {
        waiters.push({ contains, resolve });
      }),
    exited: new Promise((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
    }),
    stop: () => {
      child.kill();
    },
  };
}

function tempHome(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-cli-spawn-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not happen within ${String(TIMEOUT_MS)}ms`));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const HANDSHAKE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };

test('serve: the process starts, handshakes with the real host, and exits 0 when told to', async (t) => {
  const child = start(tempHome(t));
  try {
    child.write(HANDSHAKE);
    const reply = await withTimeout(child.waitForLine('"id":1'), 'the handshake reply');
    const parsed = JSON.parse(reply) as { result?: { protocolVersion?: number; serverVersion?: string } };
    assert.equal(parsed.result?.protocolVersion, 1);
    // The refusal placeholder reported `0.0.0+unwired`; the real host reports the build.
    assert.match(parsed.result.serverVersion ?? '', /^\d+\.\d+\.\d+/);
    assert.notEqual(parsed.result.serverVersion, '0.0.0+unwired');

    child.write({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} });
    await withTimeout(child.waitForLine('"id":2'), 'the shutdown reply');
    assert.equal(await withTimeout(child.exited, 'the process to exit'), 0);
  } finally {
    child.stop();
  }
});

test('serve: a session is created on disk, listed, and the lock is released on exit', async (t) => {
  const home = tempHome(t);
  const child = start(home);
  try {
    child.write(HANDSHAKE);
    await withTimeout(child.waitForLine('"id":1'), 'the handshake reply');

    child.write({ jsonrpc: '2.0', id: 2, method: 'session.create', params: { sessionId: 'sess_spawn' } });
    const created = JSON.parse(await withTimeout(child.waitForLine('"id":2'), 'the create reply')) as {
      result?: { sessionId?: string; lastSeq?: number };
    };
    assert.equal(created.result?.sessionId, 'sess_spawn');
    assert.equal(created.result.lastSeq, 1);

    const dir = join(home, 'sessions');
    assert.equal(existsSync(join(dir, 'sess_spawn.jsonl')), true, 'the log is written where ADR-064 says');

    child.write({ jsonrpc: '2.0', id: 3, method: 'session.list', params: {} });
    const listed = await withTimeout(child.waitForLine('"id":3'), 'the list reply');
    assert.match(listed, /sess_spawn/);

    // No model is configured in that temp home: a refusal with a code, not a crash.
    child.write({ jsonrpc: '2.0', id: 4, method: 'turn.send', params: { sessionId: 'sess_spawn', input: 'hello' } });
    const refused = JSON.parse(await withTimeout(child.waitForLine('"id":4'), 'the turn refusal')) as {
      error?: { code?: number; message?: string; data?: unknown };
    };
    assert.equal(refused.error?.code, -32004, 'hostRefused');
    assert.match(refused.error.message ?? '', /no model is configured/);
    assert.deepEqual(refused.error.data, { problem: 'not-configured' });

    child.write({ jsonrpc: '2.0', id: 5, method: 'shutdown', params: {} });
    await withTimeout(child.waitForLine('"id":5'), 'the shutdown reply');
    assert.equal(await withTimeout(child.exited, 'the process to exit'), 0);

    // Closing saved the replay snapshot (ADR-170) and released the session lock (ADR-010).
    assert.deepEqual(readdirSync(dir), ['sess_spawn.jsonl', 'sess_spawn.snapshot.json']);
  } finally {
    child.stop();
  }
});

test('serve: closing stdin is a clean exit, not a crash', async (t) => {
  const child = start(tempHome(t));
  try {
    child.write(HANDSHAKE);
    await withTimeout(child.waitForLine('"id":1'), 'the handshake reply');
    // No shutdown: the client simply goes away, which is what a dying editor looks like.
    child.closeStdin();
    const code = await withTimeout(child.exited, 'the process to exit after its stdin closed');
    assert.equal(code, 0);
  } finally {
    child.stop();
  }
});
