import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NodeBackgroundTasks,
  NodePlatform,
  NodeProcess,
  defaultSandboxProfile,
  type BackgroundExit,
  type BackgroundStart,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
} from '../src/index.js';

// The registry against real children, for the same reason the gateway tests use them:
// "the task was stopped", "the timeout fired", "the tail is the end of the stream" are
// properties of a process, and a double would answer by asserting on itself.

function registry(): NodeBackgroundTasks {
  return new NodeBackgroundTasks({ process: new NodeProcess({ platform: new NodePlatform() }) });
}

function spec(script: string, overrides: Partial<BackgroundStart> = {}): BackgroundStart {
  return {
    sessionId: 'sess_bg',
    callId: 'call_1',
    command: script,
    argv: [process.execPath, '-e', script],
    cwd: process.cwd(),
    env: {},
    sandbox: defaultSandboxProfile(),
    timeoutMs: 10_000,
    ...overrides,
  };
}

async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(ms)}ms`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

test('a task runs to completion and reports its exit with the tail', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  const task = await tasks.start(spec("process.stdout.write('hello\\n'); process.exitCode = 3"));
  assert.equal(task.taskId, 'bg_1');
  assert.equal(tasks.list().length, 1);

  await until(() => exits.length === 1);
  const exit = exits[0];
  assert.ok(exit !== undefined);
  assert.equal(exit.taskId, 'bg_1');
  assert.equal(exit.sessionId, 'sess_bg');
  assert.equal(exit.callId, 'call_1');
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.state, 'exited');
  assert.equal(exit.reason, 'none');
  assert.equal(exit.tail, 'hello\n');
  assert.equal(exit.truncated, false);
  assert.deepEqual(tasks.list(), []);
});

test('stop aborts the task once, and reports it as stopped', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  const task = await tasks.start(spec('setInterval(() => {}, 1000)'));
  assert.equal(await tasks.stop(task.taskId), true);
  await until(() => exits.length === 1);

  const exit = exits[0];
  assert.ok(exit !== undefined);
  assert.equal(exit.state, 'stopped');
  assert.equal(exit.reason, 'cancel');
  assert.equal(await tasks.stop(task.taskId), false, 'a task that already ended is not stopped twice');
});

test('the timeout belongs to the gateway, and the registry reports it as stopped', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  await tasks.start(spec('setInterval(() => {}, 1000)', { timeoutMs: 100 }));
  await until(() => exits.length === 1);

  const exit = exits[0];
  assert.ok(exit !== undefined);
  assert.equal(exit.state, 'stopped');
  assert.equal(exit.reason, 'timeout');
});

test('the tail is bounded, and the exit says how much was dropped', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  await tasks.start(spec("process.stdout.write('a'.repeat(5_000))"));
  await until(() => exits.length === 1);

  const exit = exits[0];
  assert.ok(exit !== undefined);
  assert.equal(exit.tail.length, 2_000);
  assert.equal(exit.tail, 'a'.repeat(2_000));
  assert.equal(exit.truncated, true);
  assert.equal(exit.dropped, 3_000);
});

test('the tail cap is one knob, not two', async () => {
  const tasks = new NodeBackgroundTasks({
    process: new NodeProcess({ platform: new NodePlatform() }),
    tailCap: 500,
  });
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  await tasks.start(spec("process.stdout.write('b'.repeat(5_000))"));
  await until(() => exits.length === 1);

  const exit = exits[0];
  assert.ok(exit !== undefined);
  // The same number bounds the gateway's buffer and the event's tail; a second setting
  // would let the two drift (the review that caught the first version).
  assert.equal(exit.tail.length, 500);
  assert.equal(exit.dropped, 4_500);
});

test('a command that cannot start rejects instead of handing out a task id', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  await assert.rejects(
    tasks.start(spec('', { argv: ['cowcat-no-such-binary-xyz'] })),
    /ENOENT|not found|spawn/i,
  );
  assert.deepEqual(tasks.list(), []);
  assert.deepEqual(exits, [], 'a task that never started is not a task that ended');
});

test('stopAll aborts every task and waits for their exits', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit((exit) => exits.push(exit));

  await tasks.start(spec('setInterval(() => {}, 1000)', { callId: 'call_1' }));
  await tasks.start(spec('setInterval(() => {}, 1000)', { callId: 'call_2' }));

  await tasks.stopAll();
  assert.deepEqual(tasks.list(), []);
  assert.equal(exits.length, 2);
  assert.deepEqual(
    exits.map((exit) => exit.state),
    ['stopped', 'stopped'],
  );
});

test('a listener that throws does not rob the others of the exit', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  tasks.onExit(() => {
    throw new Error('panel bug');
  });
  tasks.onExit((exit) => exits.push(exit));

  await tasks.start(spec("process.stdout.write('x')"));
  await until(() => exits.length === 1);
});

test('an exit that is already known is still reported after start returns', async () => {
  // A port that settles synchronously is the worst case for ordering: the task is over
  // before the caller has the id. The registry must not announce an exit it cannot name.
  const instant: ProcessPort = {
    run: (spec: ProcessSpec): Promise<ProcessResult> =>
      Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        dropped: { stdout: 0, stderr: 0 },
        removedEnv: [],
        ignoredDeny: [],
        sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
        termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
      }),
    open: () => Promise.reject(new Error('not used in this test')),
  };
  const tasks = new NodeBackgroundTasks({ process: instant });
  const order: string[] = [];
  tasks.onExit(() => order.push('exit'));

  const task = await tasks.start(spec('', { argv: ['instant'] }));
  order.push('started');
  await until(() => order.length === 2);
  assert.deepEqual(order, ['started', 'exit']);
  assert.equal(task.taskId, 'bg_1');
});

test('an unsubscribed listener stops hearing about exits', async () => {
  const tasks = registry();
  const exits: BackgroundExit[] = [];
  const off = tasks.onExit((exit) => exits.push(exit));
  off();

  await tasks.start(spec("process.stdout.write('done')"));
  await until(() => tasks.list().length === 0);
  assert.deepEqual(exits, []);
});
