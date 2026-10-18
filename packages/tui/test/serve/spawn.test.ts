import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ADR-059 ①: exactly one test spawns a process, and it answers the question no
 * in-process test can — does the built entry start, frame correctly over real pipes,
 * and exit with a code. Everything else about the protocol runs over the in-memory
 * transport, where the failure messages are readable.
 *
 * The entry it spawns is T3's placeholder (`src/serve/main.ts` with `refusingHost()`),
 * so the methods it can answer are the handshake and the refusals. That is enough: the
 * thing under test is the process, not the host.
 */
const ENTRY = fileURLToPath(new URL('../../src/serve/main.js', import.meta.url));
const TIMEOUT_MS = 30_000;

interface Spawned {
  write(request: object): void;
  closeStdin(): void;
  waitForLine(contains: string): Promise<string>;
  readonly exited: Promise<number | null>;
  stop(): void;
}

function start(): Spawned {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
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

test('serve: the process starts, handshakes, and exits 0 when told to', async () => {
  const child = start();
  try {
    child.write(HANDSHAKE);
    const reply = await withTimeout(child.waitForLine('"id":1'), 'the handshake reply');
    const parsed = JSON.parse(reply) as { result?: { protocolVersion?: number; serverVersion?: string } };
    assert.equal(parsed.result?.protocolVersion, 1);
    assert.equal(parsed.result.serverVersion, '0.0.0+unwired');

    child.write({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} });
    await withTimeout(child.waitForLine('"id":2'), 'the shutdown reply');
    assert.equal(await withTimeout(child.exited, 'the process to exit'), 0);
  } finally {
    child.stop();
  }
});

test('serve: the placeholder host refuses inside the real process too', async () => {
  const child = start();
  try {
    child.write(HANDSHAKE);
    await withTimeout(child.waitForLine('"id":1'), 'the handshake reply');
    child.write({ jsonrpc: '2.0', id: 2, method: 'session.list', params: {} });

    const reply = await withTimeout(child.waitForLine('"id":2'), 'the refusal');
    const parsed = JSON.parse(reply) as { error?: { code?: number; message?: string } };
    assert.equal(parsed.error?.code, -32004, 'hostRefused');
    assert.match(parsed.error.message ?? '', /composition root/);
  } finally {
    child.stop();
  }
});

test('serve: closing stdin is a clean exit, not a crash', async () => {
  const child = start();
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
