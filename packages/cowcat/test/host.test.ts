// P6 T4a 2/3 — the composition root, driven the way a frontend drives it: a real
// protocol server over the in-memory transport, with a real kernel session, real tools
// and a scripted model.
//
// What is being established here is not "the pieces work" (each has its own suite) but
// the four things only the assembled host can get wrong:
//
//   * `turn.send` answers with the turn id WHILE the turn is running;
//   * an approval asked for by the kernel reaches a client, and the client's answer
//     releases the tool call;
//   * `attach` loses nothing and repeats nothing across the read/subscribe seam;
//   * a refusal (no model configured, a path no session ever attached) comes back as a
//     protocol error a client can branch on, not as a dead process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  ProtocolClientError,
  PROTOCOL_VERSION,
  createClient,
  createServer,
  memoryTransport,
  type ProtocolClient,
  type WireDelta,
  type WireEvent,
  type WireLog,
} from '@corescense/cowcat-protocol';
import {
  createHost,
  nodePlatform,
  type CowcatHost,
  type CreateHostOptions,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
  type PlatformPort,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
  SandboxRequestRefusedError,
  type SessionShell,
  type SkillFile,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel } from './support.js';
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { createOtelSink } from '../src/adapters/otel/index.js';

const PRESET = 'anthropic/claude-sonnet-5-5';
const MCP_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.js', import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Poll a store/async predicate with a deadline; never asserts how long something took. */
async function poll(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/** A user-layer config, in the place ADR-064 puts it. */
function writeUserConfig(home: string, body: unknown): void {
  const dir = join(home, '.cowcat');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(body)}\n`);
}

function writeJson(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body)}\n`);
}

const SHELL: SessionShell & { readonly baseArgs: readonly string[]; readonly commandFlag: string } = {
  kind: 'posix',
  executable: '/bin/sh',
  baseArgs: ['-c'],
  commandFlag: '-c',
};

/**
 * A PlatformPort that answers without probing anything.
 *
 * Shell resolution spawns real processes and is covered on its own (`platform.test.ts`,
 * plus the one test below that uses the real port); here it would only make nine tests
 * slower and flakier.
 */
function fakePlatform(): PlatformPort {
  return {
    platform: 'linux',
    resolveShell: () => SHELL,
    termination: () => ({ kind: 'process-group', graceMs: 0, supportsGraceful: true }),
    sandboxBackends: () => [],
  };
}

class FakeProcess implements ProcessPort {
  readonly commands: string[] = [];

  run(spec: ProcessSpec): Promise<ProcessResult> {
    this.commands.push(spec.argv.at(-1) ?? '');
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      truncated: false,
      dropped: { stdout: 0, stderr: 0 },
      removedEnv: [],
      ignoredDeny: [],
      sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
      termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    });
  }

  open(): Promise<never> {
    return Promise.reject(new Error('FakeProcess.open() is not used in this test'));
  }
}

/** A process that stays alive until its signal aborts, then resolves as cancelled. */
class HangingProcess implements ProcessPort {
  run(spec: ProcessSpec, signal: AbortSignal): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          resolve({
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            truncated: false,
            dropped: { stdout: 0, stderr: 0 },
            removedEnv: [],
            ignoredDeny: [],
            sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
            termination: {
              requested: true,
              reason: 'cancel',
              strategy: 'single-process',
              escalated: false,
              fallbackUsed: false,
              residuePossible: false,
            },
          });
        },
        { once: true },
      );
    });
  }

  open(): Promise<never> {
    return Promise.reject(new Error('HangingProcess.open() is not used in this test'));
  }
}

/** A model whose stream never produces anything until it is cancelled. */
class HangingModel implements ModelPort {
  stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          signal.aborted
            ? Promise.reject(new Error('aborted by the client'))
            : new Promise<IteratorResult<ModelChunk>>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  reject(new Error('aborted by the client'));
                }, { once: true });
              }),
      }),
    };
  }
}

class FirstHangingModel implements ModelPort {
  calls = 0;
  readonly hanging = new HangingModel();

  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    this.calls += 1;
    if (this.calls === 1) return this.hanging.stream(request, signal);
    return (async function* (): AsyncIterable<ModelChunk> {
      yield { type: 'text', text: 'queued done' };
    })();
  }
}

class SlowStartModel implements ModelPort {
  calls = 0;

  async *stream(): AsyncIterable<ModelChunk> {
    this.calls += 1;
    if (this.calls === 1) await new Promise((resolve) => setTimeout(resolve, 50));
    yield { type: 'text', text: this.calls === 1 ? 'first done' : 'queued done' };
  }
}

/**
 * Parent asks for a delegation on its first call; everything after that hangs until the
 * turn is cancelled.
 *
 * The point is the second call: it happens inside the CHILD session, so cancellation has to
 * travel parent → spawn → child turn → child lock release (ADR-081 ⑤).
 */
class DelegatingHangingModel implements ModelPort {
  calls = 0;

  stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    this.calls += 1;
    if (this.calls === 1) {
      return (async function* (): AsyncIterable<ModelChunk> {
        yield {
          type: 'tool_call',
          call: {
            callId: 'call_task',
            name: 'Task',
            input: { description: 'wait for ever', prompt: 'wait for ever' },
          },
        };
        yield { type: 'stop', reason: { kind: 'toolCalls', raw: 'tool_calls' } };
      })();
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          signal.aborted
            ? Promise.reject(new Error('aborted by the client'))
            : new Promise<IteratorResult<ModelChunk>>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  reject(new Error('aborted by the client'));
                }, { once: true });
              }),
      }),
    };
  }
}

interface Fixture {
  readonly host: CowcatHost;
  readonly client: ProtocolClient;
  readonly events: () => readonly WireEvent[];
  readonly deltas: () => readonly WireDelta[];
  readonly logs: () => readonly WireLog[];
  /** Waits for a predicate over what the client has received. Fails loudly on a hang. */
  readonly until: (what: string, predicate: () => boolean) => Promise<void>;
  readonly close: () => Promise<void>;
}

async function start(
  options: { readonly cwd: string; readonly home: string; readonly model: ModelPort; readonly env?: Readonly<Record<string, string>> } & Pick<
    CreateHostOptions,
    'platform' | 'process' | 'store' | 'approvalTimeoutMs' | 'telemetry' | 'unattended' | 'trustStore'
  >,
): Promise<Fixture> {
  const host = await createHost({
    cwd: options.cwd,
    home: options.home,
    env: options.env ?? {},
    version: '0.0.0-test',
    model: options.model,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 5_000,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
    ...(options.trustStore === undefined ? {} : { trustStore: options.trustStore }),
  });

  const pair = memoryTransport();
  const server = createServer({ host, transport: pair.server });
  const client = createClient({ transport: pair.client });

  const events: WireEvent[] = [];
  const deltas: WireDelta[] = [];
  const logs: WireLog[] = [];
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  client.on('event', (event) => {
    events.push(event);
    wake();
  });
  client.on('delta', (delta) => {
    deltas.push(delta);
    wake();
  });
  client.on('log', (log) => {
    logs.push(log);
    wake();
  });

  // A notification-driven wait with a slow poll behind it: a predicate can also become
  // true without a message (a file on disk), and this fails with a reason instead of
  // hanging the suite. Waiting is not a timing assertion — nothing below asserts how long
  // anything took.
  async function until(what: string, predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          waiters.delete(settle);
          resolve();
        };
        waiters.add(settle);
        setTimeout(settle, 20);
      });
    }
  }

  return {
    host,
    client,
    events: () => events,
    deltas: () => deltas,
    logs: () => logs,
    until,
    close: async () => {
      client.close();
      await server.closed;
      await host.close();
    },
  };
}

/** A field of a wire event, whose body the protocol deliberately does not re-describe. */
function field(event: WireEvent | undefined, name: string): unknown {
  return event === undefined ? undefined : Reflect.get(event, name);
}

function first(events: readonly WireEvent[], type: string): WireEvent | undefined {
  return events.find((event) => event.type === type);
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => null,
    (error: unknown) => error,
  );
}

/** A 24-byte PNG: only the header and IHDR are read, which is all `Read` inspects. */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}


// ---------------------------------------------------------------------------
// Plan review bridge (ADR-125): the host side of ExitPlan
// ---------------------------------------------------------------------------

test('a timed-out review does not veto the retry: the second proposal reaches the client', async (t) => {
  const home = tempDir(t, 'cowcat-host-plan-home-');
  const cwd = tempDir(t, 'cowcat-host-plan-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const plans = (callId: string) => ({
    type: 'tool_call' as const,
    call: {
      callId,
      name: 'ExitPlan',
      input: {
        plans: [
          { title: 'small patch', summary: 'edit one file' },
          { title: 'full rewrite', summary: 'replace the module' },
        ],
      },
    },
  });
  const model = new ScriptedModel([
    [plans('call_p1')],
    [plans('call_p2')],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model, approvalTimeoutMs: 60 });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_plan_retry');
  await fixture.client.openSession('sess_plan_retry');
  await fixture.client.setPlanMode('sess_plan_retry', true);

  await fixture.client.sendTurn('sess_plan_retry', 'plan the work');
  await fixture.until('the first proposal', () => first(fixture.events(), 'plan.proposed') !== undefined);

  // Nobody answers: the review times out, the model is told "none", and it retries.
  await fixture.until('the retry proposal', () =>
    fixture.events().some((event) => event.type === 'plan.proposed' && field(event, 'callId') === 'call_p2'),
  );

  // The retry must be answerable — this is the stale-pendingPlan regression (#167 review P0).
  const second = fixture.events().find((event) => event.type === 'plan.proposed' && field(event, 'callId') === 'call_p2');
  assert.ok(second !== undefined);
  await fixture.client.respondPlan('sess_plan_retry', 'call_p2', 1, null);

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  const decided = fixture.events().find((event) => event.type === 'plan.decided' && field(event, 'callId') === 'call_p2');
  assert.equal(field(decided, 'choice'), 1);
  const modeOff = fixture.events().filter((event) => event.type === 'plan.mode-changed');
  assert.equal(
    modeOff.some((event) => field(event, 'by') === 'plan-approved' && field(event, 'enabled') === false),
    true,
  );
  const firstResult = fixture.events().find((event) => event.type === 'tool.finished' && field(event, 'callId') === 'call_p1');
  assert.match(String(field(firstResult, 'output')), /rejected every plan/);
});

test('toggling plan mode during a pending review is refused', async (t) => {
  const home = tempDir(t, 'cowcat-host-planmode-home-');
  const cwd = tempDir(t, 'cowcat-host-planmode-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [{
      type: 'tool_call' as const,
      call: {
        callId: 'call_p1',
        name: 'ExitPlan',
        input: { plans: [{ title: 'only way', summary: 'do the thing' }] },
      },
    }],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_plan_toggle');
  await fixture.client.openSession('sess_plan_toggle');
  await fixture.client.setPlanMode('sess_plan_toggle', true);
  await fixture.client.sendTurn('sess_plan_toggle', 'plan it');
  await fixture.until('the proposal', () => first(fixture.events(), 'plan.proposed') !== undefined);

  // The event can reach this client a beat before the kernel parks on the bridge. Poll:
  // a call that lands early toggles successfully (undo it and try again); once parked,
  // the same call must refuse.
  let refused: Error | null = null;
  for (let attempt = 0; attempt < 50 && refused === null; attempt += 1) {
    const result = await fixture.client.setPlanMode('sess_plan_toggle', false).then(
      () => null as Error | null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    if (result === null) {
      await fixture.client.setPlanMode('sess_plan_toggle', true).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } else if (/plan review is pending/.test(result.message)) {
      refused = result;
    } else {
      assert.fail(`unexpected setPlanMode error: ${result.message}`);
    }
  }
  assert.ok(refused !== null, 'toggle refused while a review is pending');

  await fixture.client.respondPlan('sess_plan_toggle', 'call_p1', 0, null);
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
});
// ---------------------------------------------------------------------------
// A turn, end to end
// ---------------------------------------------------------------------------

test('a turn asks before writing, and the answer releases the call', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Write', input: { file_path: join(cwd, 'hello.txt'), content: 'hi\n' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  assert.equal((await fixture.client.createSession('sess_turn')).lastSeq, 1);
  const opened = await fixture.client.openSession('sess_turn');
  assert.equal(opened.replayed, 1);

  // The reply arrives while the turn is still running: the write has not been approved
  // yet, so nothing else could have finished.
  const turnId = await fixture.client.sendTurn('sess_turn', 'write the file');
  assert.match(turnId, /^turn_/);

  // Nothing allows a write, so the baseline default is to ask (ADR-034).
  await fixture.until('the approval request', () => first(fixture.events(), 'approval.requested') !== undefined);
  const requested = first(fixture.events(), 'approval.requested');
  assert.equal(field(requested, 'name'), 'Write');
  const callId = field(requested, 'callId');
  assert.equal(typeof callId, 'string');

  await fixture.client.respondApproval('sess_turn', callId as string, 'once');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  assert.equal(readFileSync(join(cwd, 'hello.txt'), 'utf8'), 'hi\n');
  assert.equal(field(first(fixture.events(), 'tool.finished'), 'ok'), true);

  // The id `turn.send` answered with is the one the LOG opened — not a second id the
  // host made up.
  assert.equal(field(first(fixture.events(), 'turn.opened'), 'turnId'), turnId);

  // And every fact is on disk, in the layout ADR-064 names, with a gap-free `seq`.
  const file = join(home, '.cowcat', 'sessions', 'sess_turn.jsonl');
  const logged = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WireEvent);
  assert.deepEqual(logged.map((event) => event.type).slice(0, 2), ['session.opened', 'turn.opened']);
  assert.deepEqual(logged.map((event) => event.seq), logged.map((_event, index) => index + 1));
  // The question and the answer are both there, in that order (ADR-031).
  const types = logged.map((event) => event.type);
  assert.ok(types.indexOf('approval.requested') < types.indexOf('approval.answered'));
});

test('an approval answered before the kernel asks is held, not lost', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_early', name: 'Write', input: { file_path: join(cwd, 'early.txt'), content: 'ok\n' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_early');
  await fixture.client.openSession('sess_early');

  // The event is emitted before the bridge is called, so a frontend that answers the
  // instant it sees `approval.requested` can arrive first. Answering before the turn
  // even starts pins that seam deterministically (`run --yes` does the fast version).
  await fixture.client.respondApproval('sess_early', 'call_early', 'once');

  await fixture.client.sendTurn('sess_early', 'write it');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  assert.equal(readFileSync(join(cwd, 'early.txt'), 'utf8'), 'ok\n');
  const answered = first(fixture.events(), 'approval.answered');
  assert.equal(field(answered, 'verdict'), 'once');
  assert.equal(field(answered, 'by'), 'user');
});

test('TodoWrite never asks, because the host baseline says so', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [
      {
        type: 'tool_call',
        call: {
          callId: 'call_1',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Ship the host', status: 'in_progress', activeForm: 'Shipping the host' }] },
        },
      },
    ],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_todo');
  await fixture.client.openSession('sess_todo');
  await fixture.client.sendTurn('sess_todo', 'plan it');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  // Every other write-risk call asks; this one is the composition root's decision
  // (ADR-034 leaves it here, ADR-064 records it).
  assert.equal(first(fixture.events(), 'approval.requested'), undefined);

  const events = fixture.events();
  const updated = events.findIndex((event) => event.type === 'todo.updated');
  const finished = events.findIndex((event) => event.type === 'tool.finished' && field(event, 'name') === 'TodoWrite');
  assert.ok(updated >= 0 && finished >= 0);
  // The list is recorded BEFORE the result of the call that declared it (ADR-054).
  assert.ok(updated < finished);

  const todos = field(events[updated], 'todos');
  assert.equal(Array.isArray(todos), true);
  assert.equal((todos as readonly unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// Refusals a client can read
// ---------------------------------------------------------------------------

test('an unconfigured model is a refusal with a hint, not a crash', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  // No config file at all: the machine is usable (sessions, logs) but has no model.
  const fixture = await start({ cwd, home, model: new ScriptedModel([]) });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_nomodel');

  const error = await rejection(fixture.client.sendTurn('sess_nomodel', 'hello'));
  assert.ok(error instanceof ProtocolClientError);
  assert.equal(error.code, ERROR_CODES.hostRefused);
  assert.match(error.message, /no model is configured/);
  // The problem is named as data too, so a client can branch instead of matching prose.
  assert.deepEqual(error.data, { problem: 'not-configured' });
});

test('opening a session that is not there says so, and lists what is', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const fixture = await start({ cwd, home, model: new ScriptedModel([]) });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_listed');

  const listed = await fixture.client.listSessions();
  // The header facts ride the summary (ADR-126); the title stays absent — no turn yet.
  assert.equal(listed.length, 1);
  const first = listed[0];
  assert.ok(first !== undefined);
  assert.equal(first.sessionId, 'sess_listed');
  assert.equal(first.lastSeq, 1);
  assert.equal(first.cwd, cwd);
  assert.equal(first.model, PRESET);

  const error = await rejection(fixture.client.openSession('sess_missing'));
  assert.ok(error instanceof ProtocolClientError);
  assert.equal(error.code, ERROR_CODES.noSuchSession);
});

// ---------------------------------------------------------------------------
// The trust gate (ADR-028)
// ---------------------------------------------------------------------------

test('a repository cannot grant itself permissions until the workspace is trusted', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  // The repository's own file, which an untrusted checkout may not use to loosen policy.
  writeJson(join(cwd, 'cowcat.json'), {
    rules: [{ name: 'bash-is-fine', verdict: 'allow', when: { risk: 'exec' } }],
  });

  const script = (): ScriptedModel =>
    new ScriptedModel([
      [{ type: 'tool_call', call: { callId: 'call_1', name: 'Bash', input: { command: 'echo hi' } } }],
      [{ type: 'text', text: 'done' }],
    ]);

  const untrusted = await start({ cwd, home, model: script(), process: new FakeProcess() });
  t.after(() => untrusted.close());
  await untrusted.client.initialize();
  await untrusted.client.createSession('sess_untrusted');
  await untrusted.client.openSession('sess_untrusted');
  await untrusted.client.sendTurn('sess_untrusted', 'run it');
  await untrusted.until('the approval', () => first(untrusted.events(), 'approval.requested') !== undefined);
  assert.equal(untrusted.host.rules.some((rule) => rule.name === 'bash-is-fine'), false);
  await untrusted.client.respondApproval('sess_untrusted', field(first(untrusted.events(), 'approval.requested'), 'callId') as string, 'once');

  // Trusting the directory is what turns the repository's own `allow` on.
  writeJson(join(home, '.cowcat', 'trust.json'), { trusted: [cwd] });
  const trusted = await start({ cwd, home, model: script(), process: new FakeProcess() });
  t.after(() => trusted.close());
  await trusted.client.initialize();
  await trusted.client.createSession('sess_trusted');
  await trusted.client.openSession('sess_trusted');
  await trusted.client.sendTurn('sess_trusted', 'run it');
  await trusted.until('the turn to complete', () =>
    trusted.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  assert.equal(trusted.host.rules.some((rule) => rule.name === 'bash-is-fine'), true);
  assert.equal(first(trusted.events(), 'approval.requested'), undefined);
});

// ---------------------------------------------------------------------------
// Background tasks (ADR-111/112)
// ---------------------------------------------------------------------------

test('a background task is announced, and its end never lands before the start', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, {
    model: { preset: PRESET },
    rules: [{ name: 'bash-is-fine', verdict: 'allow', when: { risk: 'exec' } }],
  });

  const store = new MemoryEventStore();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } } }],
    [{ type: 'text', text: 'started' }],
  ]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    platform: fakePlatform(),
    // Instant exit is the hard case: the task is over before the turn records that it began.
    process: new FakeProcess(),
  });
  t.after(() => host.close());

  await host.createSession('sess_bg');
  await host.sendTurn('sess_bg', 'start the dev server');

  await poll(async () => (await store.readAll('sess_bg')).some((event) => event.type === 'tool.background.finished'), 'the finished event');
  const events = await store.readAll('sess_bg');
  const startedAt = events.findIndex((event) => event.type === 'tool.background.started');
  const finishedAt = events.findIndex((event) => event.type === 'tool.background.finished');
  assert.ok(startedAt >= 0, 'the start is in the log');
  assert.ok(finishedAt > startedAt, 'the end waits for the start, even when the process is already gone');
});

test('an unattended host refuses run_in_background instead of starting a process nobody can stop', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, {
    model: { preset: PRESET },
    rules: [{ name: 'bash-is-fine', verdict: 'allow', when: { risk: 'exec' } }],
  });

  const store = new MemoryEventStore();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } } }],
    [{ type: 'text', text: 'ok' }],
  ]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    unattended: true,
    platform: fakePlatform(),
    process: new FakeProcess(),
  });
  t.after(() => host.close());

  await host.createSession('sess_bg');
  await host.sendTurn('sess_bg', 'start the dev server');

  await poll(async () => (await store.readAll('sess_bg')).some((event) => event.type === 'tool.finished'), 'the tool result');
  const events = await store.readAll('sess_bg');
  const finished = events.find((event) => event.type === 'tool.finished');
  if (finished?.type !== 'tool.finished') assert.fail('expected a tool.finished event');
  assert.match(finished.output, /not available in this build/u);
  assert.equal(events.some((event) => event.type === 'tool.background.started'), false);
});

test('closing the host stops a running background task and records its end', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, {
    model: { preset: PRESET },
    rules: [{ name: 'bash-is-fine', verdict: 'allow', when: { risk: 'exec' } }],
  });

  const store = new MemoryEventStore();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } } }],
    [{ type: 'text', text: 'started' }],
  ]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    platform: fakePlatform(),
    process: new HangingProcess(),
  });

  await host.createSession('sess_bg');
  await host.sendTurn('sess_bg', 'start the dev server');
  await poll(
    async () => (await store.readAll('sess_bg')).some((event) => event.type === 'tool.background.started'),
    'the started event',
  );

  // No t.after: this test is about close() itself, and a second close would race it.
  await host.close();

  const events = await store.readAll('sess_bg');
  const finished = events.find((event) => event.type === 'tool.background.finished');
  if (finished?.type !== 'tool.background.finished') assert.fail('expected the shutdown to be recorded');
  assert.equal(finished.state, 'stopped');
  assert.equal(finished.reason, 'cancel');
});

test('task.stop stops a running task and refuses ids from another session', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, {
    model: { preset: PRESET },
    rules: [{ name: 'bash-is-fine', verdict: 'allow', when: { risk: 'exec' } }],
  });

  const store = new MemoryEventStore();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } } }],
    [{ type: 'text', text: 'started' }],
  ]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    platform: fakePlatform(),
    process: new HangingProcess(),
  });
  t.after(() => host.close());

  await host.createSession('sess_bg');
  await host.sendTurn('sess_bg', 'start the dev server');
  await poll(
    async () => (await store.readAll('sess_bg')).some((event) => event.type === 'tool.background.started'),
    'the started event',
  );

  // The task belongs to sess_bg; another session cannot stop it by id.
  await host.createSession('sess_other');
  const started = (await store.readAll('sess_bg')).find((event) => event.type === 'tool.background.started');
  if (started?.type !== 'tool.background.started') assert.fail('expected a started event');
  const { taskId } = started;

  assert.equal(await host.stopTask('sess_other', taskId), false);
  assert.equal(await host.stopTask('sess_bg', `bg_unknown`), false, 'an id that never existed is false too');

  assert.equal(await host.stopTask('sess_bg', taskId), true);
  await poll(
    async () => (await store.readAll('sess_bg')).some((event) => event.type === 'tool.background.finished'),
    'the finished event',
  );
  const finished = (await store.readAll('sess_bg')).find((event) => event.type === 'tool.background.finished');
  if (finished?.type !== 'tool.background.finished') assert.fail('expected a finished event');
  assert.equal(finished.state, 'stopped');
  assert.equal(finished.reason, 'cancel');

  assert.equal(await host.stopTask('sess_bg', taskId), false, 'an already-stopped task is false, not an error');
});

// ---------------------------------------------------------------------------
// Attachments (ADR-057)
// ---------------------------------------------------------------------------

test('attachment.read serves paths from a session log, and refuses the rest', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const bytes = pngHeader(4, 3);
  writeFileSync(join(cwd, 'shot.png'), bytes);

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Read', input: { file_path: join(cwd, 'shot.png') } } }],
    [{ type: 'text', text: 'seen' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_image');
  await fixture.client.openSession('sess_image');
  await fixture.client.sendTurn('sess_image', 'look at it');
  await fixture.until('the read to finish', () =>
    fixture.events().some((event) => event.type === 'tool.finished' && field(event, 'attachments') !== null),
  );

  const finished = fixture.events().find((event) => event.type === 'tool.finished');
  const attachments = field(finished, 'attachments');
  assert.equal(Array.isArray(attachments), true);
  const attachment = (attachments as readonly Record<string, unknown>[])[0];
  assert.ok(attachment !== undefined);
  // The id IS the path, and the bytes are not in the log.
  const id = attachment['path'];
  assert.equal(typeof id, 'string');

  const fetched = await fixture.client.readAttachment(id as string);
  assert.equal(fetched.mediaType, 'image/png');
  assert.equal(fetched.byteLength, bytes.byteLength);
  assert.deepEqual(Buffer.from(fetched.data, 'base64'), bytes);

  // Oversize is refused with the numbers, never clipped (ADR-057).
  const tooLarge = await rejection(fixture.client.readAttachment(id as string, 1));
  assert.ok(tooLarge instanceof ProtocolClientError);
  assert.equal(tooLarge.code, ERROR_CODES.attachmentTooLarge);
  assert.deepEqual(tooLarge.data, { id, byteLength: bytes.byteLength, limit: 1 });

  // A path no session ever attached is not served: the id is a path, and honouring any
  // path would make this method a file reader.
  const nowhere = await rejection(fixture.client.readAttachment(join(cwd, 'never-read.png')));
  assert.ok(nowhere instanceof ProtocolClientError);
  assert.equal(nowhere.code, ERROR_CODES.hostRefused);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('cancelling a turn stops it, and the log records why', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const fixture = await start({ cwd, home, model: new HangingModel() });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_cancel');
  await fixture.client.openSession('sess_cancel');
  // Answers with the turn id even though the model never produces a token.
  const turnId = await fixture.client.sendTurn('sess_cancel', 'do something long');
  assert.match(turnId, /^turn_/);

  await fixture.until('the turn to start streaming', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'streaming'),
  );
  await fixture.client.cancelTurn('sess_cancel');

  await fixture.until('the turn to be cancelled', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'cancelled'),
  );
});

// ---------------------------------------------------------------------------
// The attach seam
// ---------------------------------------------------------------------------

test('attach spans the read/subscribe seam with no gap and no duplicate', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  writeFileSync(join(cwd, 'a.txt'), 'one\n');

  // A store that yields to the event loop inside `readAll`, so the turn below really does
  // emit while the log is being read — the window the port's contract is about.
  const memory = new MemoryEventStore();
  const store = {
    append: (event: Parameters<MemoryEventStore['append']>[0]) => memory.append(event),
    readHeader: (sessionId: string) => memory.readHeader(sessionId),
    readAll: async (sessionId: string) => {
      const events = await memory.readAll(sessionId);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      return events;
    },
  };

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_1', name: 'Read', input: { file_path: join(cwd, 'a.txt') } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    platform: fakePlatform(),
    process: new FakeProcess(),
  });
  t.after(() => host.close());

  await host.createSession('sess_seam');
  const attaching = host.attach('sess_seam');
  await host.sendTurn('sess_seam', 'read it');
  const attached = await attaching;

  const seen: number[] = [];
  const updates: string[] = [];
  const unsubscribe = attached.subscribe((update) => {
    const record = update as { readonly type: string; readonly seq?: number };
    updates.push(record.type);
    if (record.type !== 'model.delta' && typeof record.seq === 'number') seen.push(record.seq);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  unsubscribe();

  const replaySeqs = attached.replay.map((event) => (event as { readonly seq: number }).seq);
  const merged = [...replaySeqs, ...seen];
  // The whole contract in one assertion: 1..n with nothing repeated and nothing missing.
  // Which events fell before the seam and which after is timing, and is not asserted.
  assert.deepEqual(
    merged,
    merged.map((_seq, index) => index + 1),
  );
  assert.ok(merged.length >= 4, `expected a turn's worth of events, got ${String(merged.length)}`);
  // Nothing was lost at the tail either: the last thing the subscription saw is the end
  // of the turn.
  assert.equal(updates.at(-1), 'turn.transitioned');
});

// ---------------------------------------------------------------------------
// The real platform, once
// ---------------------------------------------------------------------------

test('the session header records the shell this host resolved', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  // The real PlatformPort: resolving a shell really does probe this machine, and the
  // point of this test is that the answer reaches the log (ADR-012).
  const host = await createHost({
    cwd,
    home,
    env: process.env,
    version: '0.0.0-test',
    model: new ScriptedModel([]),
    platform: nodePlatform({ env: process.env }),
    process: new FakeProcess(),
  });
  t.after(() => host.close());

  const pair = memoryTransport();
  createServer({ host, transport: pair.server });
  const client = createClient({ transport: pair.client });
  const events: WireEvent[] = [];
  client.on('event', (event) => events.push(event));
  t.after(() => {
    client.close();
  });

  await client.initialize();
  await client.createSession('sess_shell');
  assert.equal((await client.openSession('sess_shell')).replayed, 1);
  // The reply goes out before the replay, so give the notifications their turn: this is a
  // wait, not a timing assertion.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

  const header = first(events, 'session.opened');
  const shell = field(header, 'shell') as { readonly kind?: unknown; readonly executable?: unknown } | undefined;
  assert.equal(typeof shell?.kind, 'string');
  const executable = shell?.executable;
  assert.equal(typeof executable, 'string');
  assert.ok(typeof executable === 'string' && executable.length > 0);
});

// A sanity check on the harness itself: the version this client speaks is the one the
// server expects, so nothing above is silently passing a mismatch.
test('the client and the server agree on the protocol version', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

// ---------------------------------------------------------------------------
// Delegation (ADR-079~082), driven the way a frontend drives it
// ---------------------------------------------------------------------------

test('an explore delegation runs a child session and returns only its report', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [
      {
        type: 'tool_call',
        call: {
          callId: 'call_task',
          name: 'Task',
          input: { description: 'list the files', prompt: 'list every file here', agent: 'explore' },
        },
      },
      { type: 'stop', reason: { kind: 'toolCalls', raw: 'tool_calls' } },
    ],
    [{ type: 'text', text: 'three files, all empty' }],
    [{ type: 'text', text: 'finished' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_parent');
  await fixture.client.openSession('sess_parent');
  await fixture.client.sendTurn('sess_parent', 'delegate the listing');

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  const started = first(fixture.events(), 'subagent.started');
  const childId = field(started, 'childSessionId');
  assert.equal(typeof childId, 'string');

  // Read-only delegation is free: `reads-are-free` matches the role's risk, so no human
  // is asked and the child runs immediately (ADR-080 ①).
  assert.equal(first(fixture.events(), 'approval.requested'), undefined);

  const finished = first(fixture.events(), 'subagent.finished');
  assert.equal(field(finished, 'state'), 'completed');
  assert.equal(field(finished, 'turns'), 1);
  assert.equal(field(finished, 'ok'), true);

  const done = first(fixture.events(), 'tool.finished');
  assert.equal(field(done, 'ok'), true);
  assert.match(String(field(done, 'output')), /three files, all empty/);

  // The child is a real session with its own log and its own header, and the header says
  // who delegated it (ADR-079 ③) — the one fact the parent log cannot reconstruct alone.
  const childFile = join(home, '.cowcat', 'sessions', `${String(childId)}.jsonl`);
  const childHeader = JSON.parse(readFileSync(childFile, 'utf8').split('\n')[0] ?? '{}') as Record<string, unknown>;
  assert.equal(childHeader.type, 'session.opened');
  assert.deepEqual(childHeader.parent, { sessionId: 'sess_parent', role: 'explore' });

  // Only the report reaches the parent's next request, not the child's transcript.
  const nextRequest = model.requests[2];
  assert.ok(nextRequest !== undefined);
  const sent = JSON.stringify(nextRequest.messages);
  assert.match(sent, /three files, all empty/);

  // `session.list` carries the link so a client can fold children out of its own view.
  const summaries = await fixture.host.listSessions();
  const childSummary = summaries.find((summary) => summary.sessionId === childId);
  assert.ok(childSummary !== undefined);
  assert.equal(childSummary.parentSessionId, 'sess_parent');
  const parentSummary = summaries.find((summary) => summary.sessionId === 'sess_parent');
  assert.ok(parentSummary !== undefined);
  assert.equal(parentSummary.parentSessionId, undefined);

  // The child log replays over the protocol like any other session (ADR-079 ①), and its
  // header is how a frontend learns who delegated it without reading the parent's log.
  const reopened = await fixture.client.openSession(childId as string);
  assert.ok(reopened.replayed >= 2);
  const childHeaderEvent = fixture
    .events()
    .find((event) => event.type === 'session.opened' && field(event, 'sessionId') === childId);
  assert.deepEqual(field(childHeaderEvent, 'parent'), { sessionId: 'sess_parent', role: 'explore' });
});

test('a general delegation asks before it runs, and a rejection never spawns the child', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [
      {
        type: 'tool_call',
        call: {
          callId: 'call_task',
          name: 'Task',
          input: { description: 'edit the files', prompt: 'rewrite the config', agent: 'general' },
        },
      },
      { type: 'stop', reason: { kind: 'toolCalls', raw: 'tool_calls' } },
    ],
    [{ type: 'text', text: 'doing it myself' }],
  ]);
  const store = new MemoryEventStore();
  const fixture = await start({ cwd, home, model, store });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_parent');
  await fixture.client.openSession('sess_parent');
  await fixture.client.sendTurn('sess_parent', 'delegate the rewrite');

  await fixture.until('the approval request', () => first(fixture.events(), 'approval.requested') !== undefined);
  const requested = first(fixture.events(), 'approval.requested');
  assert.equal(field(requested, 'name'), 'Task');
  const callId = field(requested, 'callId');
  assert.equal(typeof callId, 'string');

  await fixture.client.respondApproval('sess_parent', callId as string, 'reject');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  // A refused delegation leaves no child behind: no started fact, and no second session
  // header in the store.
  assert.equal(first(fixture.events(), 'subagent.started'), undefined);
  const done = first(fixture.events(), 'tool.finished');
  assert.equal(field(done, 'ok'), false);
  assert.match(String(field(done, 'output')), /rejected by user/);
  assert.equal(store.events.filter((event) => event.type === 'session.opened').length, 1);
});

test('cancelling the parent stops the child session and releases its lock (ADR-081 ⑤)', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new DelegatingHangingModel();
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_parent');
  await fixture.client.openSession('sess_parent');
  await fixture.client.sendTurn('sess_parent', 'delegate and wait');

  await fixture.until('the child to start', () => first(fixture.events(), 'subagent.started') !== undefined);
  const childId = field(first(fixture.events(), 'subagent.started'), 'childSessionId');
  assert.equal(typeof childId, 'string');

  await fixture.client.cancelTurn('sess_parent');
  await fixture.until('the parent to be cancelled', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'cancelled'),
  );

  // Both sides carry an ending: the parent says the delegation was cancelled, and the
  // child's own log says its turn was.
  const finished = first(fixture.events(), 'subagent.finished');
  assert.equal(field(finished, 'state'), 'cancelled');
  assert.equal(field(finished, 'ok'), false);

  const childFile = join(home, '.cowcat', 'sessions', `${String(childId)}.jsonl`);
  const childTypes = readFileSync(childFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly type?: string; readonly to?: string });
  assert.ok(
    childTypes.some((event) => event.type === 'turn.transitioned' && event.to === 'cancelled'),
    'the child turn must record its cancellation',
  );

  // And the lock is gone: a cancelled child must not leave a session nobody can reopen.
  assert.equal(existsSync(join(home, '.cowcat', 'sessions', `${String(childId)}.jsonl.lock`)), false);
});

// ---------------------------------------------------------------------------
// MCP (ADR-083~087), through the composed host
// ---------------------------------------------------------------------------

test('a project-declared MCP server contributes namespaced tools to a turn', async (t) => {
  // Manual dirs, and one after hook that closes the host BEFORE removing them: on
  // Windows the server child holds the workspace as its cwd, and removing it first fails
  // with EPERM (a real ordering constraint, not a flaky cleanup).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-host-home-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-host-proj-')));
  let fixture: Fixture | null = null;
  t.after(async () => {
    await fixture?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  writeUserConfig(home, {
    model: { preset: PRESET },
    // MCP tools are `exec` on purpose (ADR-084 ④); a user rule is what makes this test
    // about wiring rather than about the approval bridge.
    rules: [{ name: 'mcp-echo-is-fine', verdict: 'allow', when: { tool: 'mcp__fake__echo' } }],
  });
  writeJson(join(cwd, 'cowcat.json'), {
    mcp: { servers: { fake: { command: process.execPath, args: [MCP_SERVER, 'modern'] } } },
  });
  writeJson(join(home, '.cowcat', 'trust.json'), { trusted: [cwd] });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_mcp', name: 'mcp__fake__echo', input: { text: 'hello' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const active = await start({
    cwd,
    home,
    model,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  fixture = active;

  await active.client.initialize();
  await active.client.createSession('sess_mcp');
  await active.client.openSession('sess_mcp');
  await active.client.sendTurn('sess_mcp', 'use the echo tool');

  await active.until('the turn to complete', () =>
    active.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  const finished = first(active.events(), 'tool.finished');
  assert.equal(field(finished, 'name'), 'mcp__fake__echo');
  assert.equal(field(finished, 'ok'), true);
  assert.match(String(field(finished, 'output')), /echo: hello/u);
  // No approval was asked: the user rule matched the namespaced name.
  assert.equal(first(active.events(), 'approval.requested'), undefined);
});


// ---------------------------------------------------------------------------
// Skills (ADR-114~117)
// ---------------------------------------------------------------------------

const demoSkill = (over: Partial<SkillFile> = {}): SkillFile => ({
  name: 'demo',
  description: 'A demo skill.',
  path: '/skills/demo/SKILL.md',
  root: '/skills/demo',
  layer: 'user',
  origin: 'cowcat',
  body: 'Do the demo.',
  ignoredFields: [],
  hidden: false,
  ...over,
});

test('the composition root offers Skill and injects the catalog before the request', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const store = new MemoryEventStore();
  const model = new ScriptedModel([[{ type: 'text', text: 'ok' }]]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    skills: { discover: async () => ({ skills: [demoSkill()], warnings: [] }) },
  });
  t.after(() => host.close());

  await host.createSession('sess_skills');
  await host.sendTurn('sess_skills', 'use the demo skill');
  await poll(
    async () => (await store.readAll('sess_skills')).some((event) => event.type === 'turn.transitioned' && event.to === 'completed'),
    'the turn to complete',
  );

  const request = model.requests[0];
  assert.ok(request !== undefined);
  assert.ok(
    request.tools.some((tool) => tool.name === 'Skill'),
    'the tool the catalog tells the model to call is actually on the wire',
  );
  const first = request.messages[0];
  assert.ok(first !== undefined);
  assert.equal(first.role, 'user');
  assert.match(first.text, /demo: A demo skill\./);

  const events = await store.readAll('sess_skills');
  assert.ok(events.some((event) => event.type === 'skills.loaded'));
});

test('a project skill in an untrusted folder is neither offered nor announced as available', async (t) => {
  const home = tempDir(t, 'cowcat-host-home-');
  const cwd = tempDir(t, 'cowcat-host-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const store = new MemoryEventStore();
  const model = new ScriptedModel([[{ type: 'text', text: 'ok' }]]);
  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model,
    store,
    skills: { discover: async () => ({ skills: [demoSkill({ layer: 'project' })], warnings: [] }) },
  });
  t.after(() => host.close());

  await host.createSession('sess_untrusted');
  await host.sendTurn('sess_untrusted', 'hello');
  await poll(
    async () => (await store.readAll('sess_untrusted')).some((event) => event.type === 'turn.transitioned' && event.to === 'completed'),
    'the turn to complete',
  );

  const request = model.requests[0];
  assert.ok(request !== undefined);
  assert.equal(
    request.tools.some((tool) => tool.name === 'Skill'),
    false,
    'without a visible skill the tool is not offered at all',
  );

  const events = await store.readAll('sess_untrusted');
  assert.equal(events.some((event) => event.type === 'skills.loaded'), false);
  const noted = events.find((event) => event.type === 'turn.noted');
  assert.ok(noted !== undefined);
  assert.equal(noted.type, 'turn.noted');
  assert.equal(noted.note, 'skills-skipped');
});

// ---------------------------------------------------------------------------
// Session experience (ADR-126/127/128): fork, @ file references
// ---------------------------------------------------------------------------

test('a session forks by replay: new identity, inherited conversation, refuses while running', async (t) => {
  const home = tempDir(t, 'cowcat-fork-home-');
  const cwd = tempDir(t, 'cowcat-fork-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [{ type: 'text', text: 'first answer' }],
    [{ type: 'text', text: 'second answer' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_fork_src');
  await fixture.client.openSession('sess_fork_src');
  await fixture.client.sendTurn('sess_fork_src', 'what is this repo');
  await fixture.until('the first turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  const forkedId = await fixture.client.forkSession('sess_fork_src');
  assert.match(forkedId, /^sess_/);
  assert.notEqual(forkedId, 'sess_fork_src');

  const opened = await fixture.client.openSession(forkedId);
  assert.ok(opened.replayed >= 3, 'the fork replays the source conversation');

  // The fork log is a first-class log: header names the fork parent, and every line
  // carries the FORK's id (a byte copy would have left the source's id in every line).
  const forkLog = readFileSync(join(home, '.cowcat', 'sessions', `${forkedId}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type?: string; sessionId?: string; parent: { role?: string; sessionId?: string } | undefined });
  const header = forkLog[0];
  assert.ok(header !== undefined);
  assert.equal(header.type, 'session.opened');
  const parentInfo: { role?: string; sessionId?: string } | undefined = header.parent;
  assert.deepEqual(parentInfo, { role: 'fork', sessionId: 'sess_fork_src' });
  assert.ok(forkLog.every((line) => line.sessionId === forkedId), 'every audit field names the fork');
  const srcLogLines = readFileSync(join(home, '.cowcat', 'sessions', 'sess_fork_src.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0).length;
  assert.equal(forkLog.length, srcLogLines, 'same event count, header for header');

  // The fork answers on its own: its second turn runs the second scripted round.
  await fixture.client.sendTurn(forkedId, 'and now?');
  await fixture.until('the fork turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  // A running turn refuses the fork (covered by its own test below).
});

test('turn.send carries @ files into the log ahead of the prompt; a bad file refuses the whole send', async (t) => {
  const home = tempDir(t, 'cowcat-at-home-');
  const cwd = tempDir(t, 'cowcat-at-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const notes = join(cwd, 'notes.md');
  writeFileSync(notes, '# Notes\nkeep it simple\n');
  const binary = join(cwd, 'blob.bin');
  writeFileSync(binary, Buffer.from([0xff, 0xfe, 0xfd]));
  const big = join(cwd, 'big.txt');
  writeFileSync(big, 'x'.repeat(33 * 1024));

  const model = new ScriptedModel([
    [{ type: 'text', text: 'read it' }],
    [{ type: 'text', text: 'plain answer' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_at');
  await fixture.client.openSession('sess_at');

  await fixture.client.sendTurn('sess_at', '总结这个文件', [notes]);
  await fixture.until('the attached turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  const attached = first(fixture.events(), 'prompt.attached');
  assert.ok(attached !== undefined);
  const filesField = field(attached, 'files') as readonly { readonly name?: unknown }[] | undefined;
  assert.equal(filesField?.[0]?.name, notes, 'the name is the path as given, so同名文件可区分');
  const opened = first(fixture.events(), 'turn.opened');
  assert.ok(attached.seq < (opened?.seq ?? 0), 'attachment lands ahead of the prompt');
  const request = model.requests[0];
  assert.ok(request !== undefined && JSON.stringify(request.messages).includes('keep it simple'), 'the model sees the file');

  // A missing file refuses the WHOLE send: no turn.opened at all. The session's idle
  // flag clears a beat after the completed event, so retry past that race.
  let refused = false;
  for (let attempt = 0; attempt < 20 && !refused; attempt += 1) {
    try {
      await fixture.client.sendTurn('sess_at', 'this must not start', [join(cwd, 'nope.md')]);
    } catch (error) {
      const text = String(error);
      if (/already has a turn running/.test(text)) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      assert.match(text, /cannot be read|读不到/);
      refused = true;
    }
  }
  assert.equal(refused, true, 'the missing file refused the send');
  assert.equal(fixture.events().filter((event) => event.type === 'turn.opened').length, 1, 'no second turn opened');

  // Binary is refused with the UTF-8 reason.
  await assert.rejects(fixture.client.sendTurn('sess_at', 'binary', [binary]), /UTF-8/);

  // Over the 32KB cap.
  await assert.rejects(fixture.client.sendTurn('sess_at', 'big', [big]), /cap|上限/);

  // The session is still usable after the refusals.
  await fixture.client.sendTurn('sess_at', 'plain');
  await fixture.until('the plain turn to complete', () =>
    fixture.events().filter((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed').length >= 2,
  );
});

test('fork refuses while a turn is running', async (t) => {
  const home = tempDir(t, 'cowcat-forkrun-home-');
  const cwd = tempDir(t, 'cowcat-forkrun-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const gate = new Promise<void>((resolve) => setTimeout(resolve, 400));
  const model: ModelPort = {
    async *stream() {
      await gate;
      yield { type: 'text', text: 'done' };
    },
  };
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_busy');
  await fixture.client.openSession('sess_busy');
  await fixture.client.sendTurn('sess_busy', 'slow turn');
  await fixture.until('the turn to start', () => first(fixture.events(), 'turn.opened') !== undefined);

  await assert.rejects(fixture.client.forkSession('sess_busy'), /running turn/);
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  const forkedId = await fixture.client.forkSession('sess_busy');
  assert.match(forkedId, /^sess_/);
});

test('a fork inherits plan mode and the header facts of its source', async (t) => {
  const home = tempDir(t, 'cowcat-forkmode-home-');
  const cwd = tempDir(t, 'cowcat-forkmode-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([[{ type: 'text', text: 'ok' }]]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_forkmode');
  await fixture.client.openSession('sess_forkmode');
  await fixture.client.setPlanMode('sess_forkmode', true);

  const forkedId = await fixture.client.forkSession('sess_forkmode');
  const log = readFileSync(join(home, '.cowcat', 'sessions', `${forkedId}.jsonl`), 'utf8');
  const types = log.split('\n').filter((line) => line.length > 0).map((line) => (JSON.parse(line) as { type: string }).type);
  // The mode change replays into the fork: planMode is folded state, so the fork
  // opens still in plan mode — that is inheritance, not coincidence.
  assert.ok(types.includes('plan.mode-changed'));
  const header = JSON.parse(log.split('\n')[0] ?? '{}') as { cwd?: string; model?: string };
  assert.equal(header.cwd, cwd, 'fork header inherits the source cwd');
  assert.equal(header.model, PRESET, 'fork header inherits the source model');
});

test('a send with @ files refuses before the model check leaves an orphan attachment', async (t) => {
  const home = tempDir(t, 'cowcat-atorphan-home-');
  const cwd = tempDir(t, 'cowcat-atorphan-proj-');
  // No model configured: currentModel refuses. The refusal must happen BEFORE any
  // prompt.attached is emitted, or the log holds an orphan attachment (review P1-2).
  const notes = join(cwd, 'notes.md');
  writeFileSync(notes, 'hello\n');

  const model = new ScriptedModel([[{ type: 'text', text: 'unreachable' }]]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_orphan');
  await fixture.client.openSession('sess_orphan');

  await assert.rejects(fixture.client.sendTurn('sess_orphan', 'hi', [notes]));
  assert.equal(
    fixture.events().some((event) => event.type === 'prompt.attached'),
    false,
    'no orphan attachment in the log',
  );
});

// ---------------------------------------------------------------------------
// Escalate: deny -> appeal -> one retry (ADR-129), refusal stands (ADR-129 5)
// ---------------------------------------------------------------------------

const ESCALATE_RULES = {
  model: { preset: PRESET },
  rules: [{ name: 'no-blocked-echo', verdict: 'deny', when: { tool: 'Bash', command: 'echo blocked' } }],
};

test('a denied action can be escalated: approved once buys exactly one retry', async (t) => {
  const home = tempDir(t, 'cowcat-esc-home-');
  const cwd = tempDir(t, 'cowcat-esc-proj-');
  writeUserConfig(home, ESCALATE_RULES);

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'tool_call', call: { callId: 'c2', name: 'Escalate', input: { name: 'Bash', command: 'echo blocked', justification: 'the test needs this exact echo' } } }],
    [{ type: 'tool_call', call: { callId: 'c3', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'tool_call', call: { callId: 'c4', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_esc');
  await fixture.client.openSession('sess_esc');
  await fixture.client.sendTurn('sess_esc', 'run the blocked command');

  await fixture.until('the escalation question', () => first(fixture.events(), 'approval.requested') !== undefined);
  const requested = first(fixture.events(), 'approval.requested');
  assert.equal(field(requested, 'rule'), 'escalation');
  assert.equal(field(requested, 'command'), 'echo blocked', 'the card-carrying subject is the exact command');
  assert.deepEqual(field(requested, 'dimensions'), ['deny-override']);
  await fixture.client.respondApproval('sess_esc', field(requested, 'callId') as string, 'once');

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  const bash = fixture.events().filter((event) => event.type === 'tool.finished' && field(event, 'name') === 'Bash');
  assert.equal(bash.length, 3);
  assert.equal(field(bash[0], 'ok'), false, 'first attempt denied by the rule');
  assert.match(String(field(bash[0], 'output')), /denied by no-blocked-echo/);
  assert.equal(field(bash[1], 'ok'), true, 'the approved retry passes the deny');
  assert.equal(field(bash[2], 'ok'), false, 'a once grant buys exactly one retry');
  assert.match(String(field(bash[2], 'output')), /denied by no-blocked-echo/);

  const granted = first(fixture.events(), 'escalation.granted');
  assert.ok(granted !== undefined && field(granted, 'scope') === 'once');
  assert.ok(first(fixture.events(), 'escalation.consumed') !== undefined, 'the once grant burned on the retry');
});

test('a rejected appeal stands: the retry is refused without a second question', async (t) => {
  const home = tempDir(t, 'cowcat-escno-home-');
  const cwd = tempDir(t, 'cowcat-escno-proj-');
  writeUserConfig(home, ESCALATE_RULES);

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'tool_call', call: { callId: 'c2', name: 'Escalate', input: { name: 'Bash', command: 'echo blocked', justification: 'please' } } }],
    [{ type: 'tool_call', call: { callId: 'c3', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'tool_call', call: { callId: 'c4', name: 'Escalate', input: { name: 'Bash', command: 'echo blocked', justification: 'asking again' } } }],
    [{ type: 'text', text: 'gave up' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_escno');
  await fixture.client.openSession('sess_escno');
  await fixture.client.sendTurn('sess_escno', 'try the blocked command');

  await fixture.until('the escalation question', () => first(fixture.events(), 'approval.requested') !== undefined);
  await fixture.client.respondApproval('sess_escno', field(first(fixture.events(), 'approval.requested'), 'callId') as string, 'reject');

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  assert.equal(
    fixture.events().filter((event) => event.type === 'approval.requested').length,
    1,
    'the refusal stands: no second question, for the retry or the re-appeal',
  );
  const escalates = fixture.events().filter((event) => event.type === 'tool.finished' && field(event, 'name') === 'Escalate');
  assert.equal(escalates.length, 2);
  assert.equal(field(escalates[0], 'ok'), false);
  assert.match(String(field(escalates[1], 'output')), /already refused/, 'the second appeal is answered from the log, not the user');
});

test('Escalate refuses to appeal an action that was never denied', async (t) => {
  const home = tempDir(t, 'cowcat-escok-home-');
  const cwd = tempDir(t, 'cowcat-escok-proj-');
  writeUserConfig(home, ESCALATE_RULES);

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Escalate', input: { name: 'Bash', command: 'echo fine', justification: 'pre-authorizing' } } }],
    [{ type: 'text', text: 'ok' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_escok');
  await fixture.client.openSession('sess_escok');
  await fixture.client.sendTurn('sess_escok', 'pre-authorize');

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  assert.equal(first(fixture.events(), 'approval.requested'), undefined, 'no question is asked for a non-denied action');
  const finished = first(fixture.events(), 'tool.finished');
  assert.match(String(field(finished, 'output')), /only for actions a rule denied/);
});

test('usage totals accumulate per turn and ride session.open; a fork inherits the meter', async (t) => {
  const home = tempDir(t, 'cowcat-usage-home-');
  const cwd = tempDir(t, 'cowcat-usage-proj-');
  writeUserConfig(home, {
    model: {
      preset: PRESET,
      presets: {
        [PRESET]: {
          protocol: 'anthropic',
          model: 'claude-test',
          price: { input: 3, output: 15, cacheRead: 0.3 },
        },
      },
    },
  });

  const usageChunk = { type: 'usage' as const, usage: { input: 100, output: 20, cacheRead: 50, cacheCreation: 5 } };
  const model = new ScriptedModel([
    [{ type: 'text', text: 'one' }, usageChunk],
    [{ type: 'text', text: 'two' }, usageChunk],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_usage');
  await fixture.client.openSession('sess_usage');

  await fixture.client.sendTurn('sess_usage', 'first');
  await fixture.until('the first turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  // The preset's price rides turn.opened for the meter (ADR-131 ②).
  const opened = first(fixture.events(), 'turn.opened');
  assert.deepEqual(field(opened, 'price'), { input: 3, output: 15, cacheRead: 0.3 });

  const reopened = await fixture.client.openSession('sess_usage');
  assert.deepEqual(reopened.usage, { input: 100, output: 20, cacheRead: 50, cacheCreation: 5 });

  const before = fixture.events().length;
  await fixture.client.sendTurn('sess_usage', 'second');
  await fixture.until('the second turn to complete', () =>
    fixture.events().slice(before).some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  const afterTwo = await fixture.client.openSession('sess_usage');
  assert.deepEqual(afterTwo.usage, { input: 200, output: 40, cacheRead: 100, cacheCreation: 10 }, 'the meter accumulates');

  const forkedId = await fixture.client.forkSession('sess_usage');
  const forked = await fixture.client.openSession(forkedId);
  assert.deepEqual(forked.usage, afterTwo.usage, 'a fork inherits the parent meter through replay');
});


test('a sandbox refusal can be appealed unsandboxed: refusal (round N) -> appeal (round N+1) -> waived run', async (t) => {
  const home = tempDir(t, 'cowcat-unsandbox-home-');
  const cwd = tempDir(t, 'cowcat-unsandbox-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  // Refuses the exact command once (the sandbox precedent), then runs and records the
  // sandbox mode the spec carried — the waived retry must arrive with mode 'off'.
  const seenModes: string[] = [];
  let refused = false;
  const process: ProcessPort = {
    async run(spec: ProcessSpec): Promise<ProcessResult> {
      const command = spec.argv.at(-1) ?? '';
      if (!refused && command === 'npm run release') {
        refused = true;
        throw new SandboxRequestRefusedError('network: on', 'test refusal', 'profile forbids the network', ['run without the network']);
      }
      seenModes.push(spec.sandbox.mode);
      return {
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        dropped: { stdout: 0, stderr: 0 },
        removedEnv: [],
        ignoredDeny: [],
        sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
        termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
      };
    },
    open(): Promise<never> {
      return Promise.reject(new Error('not used'));
    },
  };

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Bash', input: { command: 'npm run release' } } }],
    [{ type: 'tool_call', call: { callId: 'c2', name: 'Escalate', input: { name: 'Bash', command: 'npm run release', justification: '发布需要联网', withoutSandbox: true } } }],
    [{ type: 'tool_call', call: { callId: 'c3', name: 'Bash', input: { command: 'npm run release' } } }],
    [{ type: 'text', text: 'released' }],
  ]);
  const fixture = await start({ cwd, home, model, process });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_unsandbox');
  await fixture.client.openSession('sess_unsandbox');
  await fixture.client.sendTurn('sess_unsandbox', 'ship it');

  // Answer questions as they arrive: round 1's exec ask, the unsandbox appeal, and the
  // retry's own exec ask (each dimension is approved on its own line — the waiver says
  // nothing about the exec-risk question).
  const answered = new Set<string>();
  const deadline = Date.now();
  let completed = false;
  while (Date.now() - deadline < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const requests = fixture.events().filter((event) => event.type === 'approval.requested');
    for (const request of requests) {
      const callId = field(request, 'callId') as string;
      if (!answered.has(callId)) {
        answered.add(callId);
        await fixture.client.respondApproval('sess_unsandbox', callId, 'once');
      }
    }
    if (fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed')) {
      completed = true;
      break;
    }
  }
  assert.equal(completed, true, 'the turn completed');

  const requested = fixture.events().find((event) => event.type === 'approval.requested' && field(event, 'rule') === 'escalation');
  assert.deepEqual(field(requested, 'dimensions'), ['unsandboxed']);
  const bash = fixture.events().filter((event) => event.type === 'tool.finished' && field(event, 'name') === 'Bash');
  assert.equal(bash.length, 2);
  assert.equal(field(bash[0], 'ok'), false);
  assert.match(String(field(bash[0], 'output')), /sandbox refused/);
  assert.equal(field(bash[1], 'ok'), true, 'the waived retry runs');
  assert.deepEqual(seenModes, ['off'], 'the retry arrived without the sandbox');
});

test('Escalate reaches the user at most three times per turn', async (t) => {
  const home = tempDir(t, 'cowcat-esclimit-home-');
  const cwd = tempDir(t, 'cowcat-esclimit-proj-');
  // Four distinct denied commands: each appeal keys on its own subject, so the refused
  // short-circuit cannot fire and the questions keep coming — until the turn limit does.
  writeUserConfig(home, {
    model: { preset: PRESET },
    rules: [1, 2, 3, 4].map((n) => ({ name: `no-echo-${String(n)}`, verdict: 'deny', when: { tool: 'Bash', command: `echo blocked${String(n)}` } })),
  });

  const appeal = (callId: string, command: string, justification: string): readonly ModelChunk[] => [
    { type: 'tool_call', call: { callId, name: 'Escalate', input: { name: 'Bash', command, justification } } },
  ];
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Bash', input: { command: 'echo blocked1' } } }],
    appeal('c2', 'echo blocked1', 'first'),
    appeal('c3', 'echo blocked2', 'second'),
    appeal('c4', 'echo blocked3', 'third'),
    appeal('c5', 'echo blocked4', 'fourth'),
    [{ type: 'text', text: 'done asking' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_esclimit');
  await fixture.client.openSession('sess_esclimit');
  await fixture.client.sendTurn('sess_esclimit', 'keep asking');

  // Answer the three questions as they arrive.
  for (let answered = 0; answered < 3; answered += 1) {
    await fixture.until(`appeal ${String(answered + 1)}`, () =>
      fixture.events().filter((event) => event.type === 'approval.requested').length > answered,
    );
    const requests = fixture.events().filter((event) => event.type === 'approval.requested');
    await fixture.client.respondApproval('sess_esclimit', field(requests[answered], 'callId') as string, 'reject');
  }

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  assert.equal(fixture.events().filter((event) => event.type === 'approval.requested').length, 3);
  const escalates = fixture.events().filter((event) => event.type === 'tool.finished' && field(event, 'name') === 'Escalate');
  assert.equal(escalates.length, 4);
  assert.match(String(field(escalates[3], 'output')), /at most 3 times per turn/);
});

test('a plan-mode block does not burn the escalation grant', async (t) => {
  const home = tempDir(t, 'cowcat-escplan-home-');
  const cwd = tempDir(t, 'cowcat-escplan-proj-');
  writeUserConfig(home, ESCALATE_RULES);

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'tool_call', call: { callId: 'c2', name: 'Escalate', input: { name: 'Bash', command: 'echo blocked', justification: '需要它' } } }],
    [{ type: 'tool_call', call: { callId: 'c3', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'tool_call', call: { callId: 'c4', name: 'Bash', input: { command: 'echo blocked' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_escplan');
  await fixture.client.openSession('sess_escplan');
  await fixture.client.setPlanMode('sess_escplan', true);
  await fixture.client.sendTurn('sess_escplan', 'try while planning');

  await fixture.until('the escalation question', () => first(fixture.events(), 'approval.requested') !== undefined);
  await fixture.client.respondApproval('sess_escplan', field(first(fixture.events(), 'approval.requested'), 'callId') as string, 'once');

  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  // The retry was blocked by plan mode, and the grant must NOT have been consumed:
  // burning it on a call that could not run would waste the approval (review P1-3).
  // Plan mode stays on to the end of the turn, so every Bash here is refused — what
  // the test guards is the ABSENCE of the consumption event, i.e. the grant survives
  // for a retry that can actually run.
  assert.equal(first(fixture.events(), 'escalation.consumed'), undefined);
  const bash = fixture.events().filter((event) => event.type === 'tool.finished' && field(event, 'name') === 'Bash');
  assert.equal(bash.length, 3);
  assert.equal(field(bash[0], 'ok'), false);
  assert.match(String(field(bash[0], 'output')), /denied by no-blocked-echo/);
  assert.equal(field(bash[1], 'ok'), false);
  assert.match(String(field(bash[1], 'output')), /plan mode/);
  assert.equal(field(bash[2], 'ok'), false, 'plan mode still refuses the retry; the grant is untouched, not spent');
  assert.ok(first(fixture.events(), 'escalation.granted') !== undefined);
});

// ---------------------------------------------------------------------------
// Telemetry (ADR-132~134), through the composed host
// ---------------------------------------------------------------------------

/** An in-memory telemetry handle: SimpleSpanProcessor exports synchronously on span end. */
function memoryTelemetry() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return {
    handle: { sink: createOtelSink(provider, 'cowcat', '0.0.0-test'), finish: async () => undefined },
    spans: () => exporter.getFinishedSpans(),
  };
}

test('telemetry spans carry the provider name primed from the session header at adopt', async (t) => {
  const home = tempDir(t, 'cowcat-otel-home-');
  const cwd = tempDir(t, 'cowcat-otel-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const telemetry = memoryTelemetry();
  const model = new ScriptedModel([[{ type: 'text', text: 'hello' }]]);
  const fixture = await start({ cwd, home, model, telemetry: telemetry.handle });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_otel');
  await fixture.client.openSession('sess_otel');
  await fixture.client.sendTurn('sess_otel', 'hi');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  await fixture.close();

  const spans = telemetry.spans();
  const turn = spans.find((s) => s.name === 'invoke_agent cowcat');
  assert.ok(turn);
  // The review of #186 caught this as dead code: session.opened goes by BEFORE the
  // tap subscribes, so priming from the log header is the only way this Required
  // semconv attribute ever gets set.
  assert.equal(turn.attributes['gen_ai.provider.name'], 'anthropic');
  assert.equal(turn.attributes['gen_ai.conversation.id'], 'sess_otel');
  const chat = spans.find((s) => s.name.startsWith('chat '));
  assert.ok(chat);
  assert.equal(chat.attributes['gen_ai.provider.name'], 'anthropic');
  assert.equal(chat.attributes['gen_ai.operation.name'], 'chat');
});

test('a subagent turn produces its own conversation span tree (ADR-132 ③)', async (t) => {
  const home = tempDir(t, 'cowcat-otel-sub-home-');
  const cwd = tempDir(t, 'cowcat-otel-sub-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const telemetry = memoryTelemetry();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Task', input: { description: 'look around', prompt: 'list the files' } } }],
    [{ type: 'text', text: 'child report' }],
    [{ type: 'text', text: 'parent done' }],
  ]);
  const fixture = await start({ cwd, home, model, telemetry: telemetry.handle });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_otel_sub');
  await fixture.client.openSession('sess_otel_sub');
  await fixture.client.sendTurn('sess_otel_sub', 'delegate');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  await fixture.close();

  const childId = field(first(fixture.events(), 'subagent.started'), 'childSessionId');
  const spans = telemetry.spans();
  const childTurn = spans.find((s) => s.attributes['gen_ai.conversation.id'] === childId && s.name === 'invoke_agent cowcat');
  assert.ok(childTurn, 'the child session gets its own turn span under its own conversation id');
  const childChat = spans.find(
    (s) => s.attributes['gen_ai.conversation.id'] === childId && s.name.startsWith('chat '),
  );
  assert.ok(childChat, 'the child model round is metered too');
  const parentTurn = spans.find(
    (s) => s.attributes['gen_ai.conversation.id'] === 'sess_otel_sub' && s.name === 'invoke_agent cowcat',
  );
  assert.ok(parentTurn);
  const taskSpan = spans.find(
    (s) => s.attributes['gen_ai.conversation.id'] === 'sess_otel_sub' && s.name === 'execute_tool Task',
  );
  assert.ok(taskSpan, 'the delegation itself is a tool span on the parent');
});
// ---------------------------------------------------------------------------
// Memory distillation (ADR-135~137)
// ---------------------------------------------------------------------------

test('memory.reflect=on runs one restricted reflect turn after a completed turn', async (t) => {
  const home = tempDir(t, 'cowcat-mem-home-');
  const cwd = tempDir(t, 'cowcat-mem-proj-');
  writeUserConfig(home, { model: { preset: PRESET }, memory: { reflect: 'on' } });

  const model = new ScriptedModel([
    [{ type: 'text', text: 'task finished' }],
    [{ type: 'text', text: 'nothing worth persisting' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_reflect');
  await fixture.client.openSession('sess_reflect');
  await fixture.client.sendTurn('sess_reflect', 'do the task');
  await fixture.until('both turns to complete', () =>
    fixture.events().filter((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed').length >= 2,
  );

  assert.equal(model.requests.length, 2, 'the reflect turn made exactly one model request');
  const reflectRequest = model.requests[1];
  assert.ok(reflectRequest);
  assert.equal(reflectRequest.tools.length, 1);
  const onlyTool = reflectRequest.tools[0];
  assert.ok(onlyTool);
  assert.equal((onlyTool as { readonly name: string }).name, 'Remember', 'the reflect turn sees only Remember');
  // The template reaches the model as an ordinary user message; stringify the tail
  // rather than narrowing the message union — the assertion is about the text.
  assert.match(JSON.stringify(reflectRequest.messages), /Reflect on this session/);
});

test('memory.reflect defaults to off: no second model request after the turn', async (t) => {
  const home = tempDir(t, 'cowcat-memoff-home-');
  const cwd = tempDir(t, 'cowcat-memoff-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_memoff');
  await fixture.client.openSession('sess_memoff');
  await fixture.client.sendTurn('sess_memoff', 'hi');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(model.requests.length, 1, 'default off means zero background model calls');
});

test('unattended sessions never reflect (an approval nobody can answer must not hang)', async (t) => {
  const home = tempDir(t, 'cowcat-memun-home-');
  const cwd = tempDir(t, 'cowcat-memun-proj-');
  writeUserConfig(home, { model: { preset: PRESET }, memory: { reflect: 'on' } });

  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const fixture = await start({ cwd, home, model, unattended: true });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_memun');
  await fixture.client.openSession('sess_memun');
  await fixture.client.sendTurn('sess_memun', 'run');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(model.requests.length, 1);
});

test('Remember writes through the real approval bridge in a trusted workspace', async (t) => {
  const home = tempDir(t, 'cowcat-remhome-');
  const cwd = tempDir(t, 'cowcat-remproj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  writeJson(join(home, '.cowcat', 'trust.json'), { trusted: [cwd] });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_remember', name: 'Remember', input: { target: 'instructions-project', content: '- run the lint gate before every commit' } } }],
    [{ type: 'text', text: 'remembered' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_remember');
  await fixture.client.openSession('sess_remember');
  await fixture.client.sendTurn('sess_remember', 'distill that lesson');
  await fixture.until('the write approval', () =>
    fixture.events().some((e) => e.type === 'approval.requested' && field(e, 'name') === 'Remember'),
  );
  const ask = first(fixture.events(), 'approval.requested');
  assert.equal(field(ask, 'name'), 'Remember');
  await fixture.client.respondApproval('sess_remember', field(ask, 'callId') as string, 'once');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );

  const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(written, /run the lint gate before every commit/);
  const finished = fixture.events().find((e) => e.type === 'tool.finished' && field(e, 'name') === 'Remember');
  assert.equal(field(finished, 'ok'), true);
});

test('an untrusted workspace refuses project memory without ever asking', async (t) => {
  const home = tempDir(t, 'cowcat-remref-home-');
  const cwd = tempDir(t, 'cowcat-remref-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'call_remember', name: 'Remember', input: { target: 'instructions-project', content: 'sneaky instruction' } } }],
    [{ type: 'text', text: 'it refused' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_remref');
  await fixture.client.openSession('sess_remref');
  await fixture.client.sendTurn('sess_remref', 'try to remember this');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );

  assert.equal(
    fixture.events().some((e) => e.type === 'approval.requested' && field(e, 'name') === 'Remember'),
    false,
    'the trust gate fires before the approval bridge',
  );
  const finished = fixture.events().find((e) => e.type === 'tool.finished' && field(e, 'name') === 'Remember');
  assert.equal(field(finished, 'ok'), false);
  assert.match(String(field(finished, 'output')), /not trusted/);
  assert.equal(existsSync(join(cwd, 'AGENTS.md')), false, 'nothing lands on disk');
});

test('a project config cannot turn reflection on (cost is the user layer decision)', async (t) => {
  const home = tempDir(t, 'cowcat-memlay-home-');
  const cwd = tempDir(t, 'cowcat-memlay-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  writeJson(join(cwd, 'cowcat.json'), { memory: { reflect: 'on' } });

  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  assert.ok(fixture.host.configWarnings.some((w) => w.includes('memory') && w.includes('ADR-137')));
  await fixture.client.createSession('sess_memlay');
  await fixture.client.openSession('sess_memlay');
  await fixture.client.sendTurn('sess_memlay', 'hi');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(model.requests.length, 1, 'the project layer was ignored');
});
test('an Escalate appeal cannot smuggle project memory past the trust gate (ADR-136 ②)', async (t) => {
  const home = tempDir(t, 'cowcat-memesc-home-');
  const cwd = tempDir(t, 'cowcat-memesc-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c_denied', name: 'Remember', input: { target: 'instructions-project', content: 'sneaky one' } } }],
    [{ type: 'tool_call', call: { callId: 'c_escalate', name: 'Escalate', input: { name: 'Remember', command: 'instructions-project', justification: 'the task genuinely needs this write' } } }],
    [{ type: 'tool_call', call: { callId: 'c_retry', name: 'Remember', input: { target: 'instructions-project', content: 'sneaky one' } } }],
    [{ type: 'text', text: 'the gate held' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_memesc');
  await fixture.client.openSession('sess_memesc');
  await fixture.client.sendTurn('sess_memesc', 'try hard to remember this');
  await fixture.until('the escalation approval', () =>
    fixture.events().some((e) => e.type === 'approval.requested' && field(e, 'rule') === 'escalation'),
  );
  const ask = fixture.events().find((e) => e.type === 'approval.requested' && field(e, 'rule') === 'escalation');
  await fixture.client.respondApproval('sess_memesc', field(ask, 'callId') as string, 'once');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );

  const retry = fixture.events().find((e) => e.type === 'tool.finished' && field(e, 'callId') === 'c_retry');
  assert.ok(retry, 'the escalate grant did let the retry reach the tool');
  assert.equal(field(retry, 'ok'), false, 'and the in-tool trust gate refused it');
  assert.match(String(field(retry, 'output')), /not trusted/);
  assert.equal(existsSync(join(cwd, 'AGENTS.md')), false, 'untrusted stays untrusted');
});

test('an always answer on a target covers that targets later writes (approvalKey name+target)', async (t) => {
  const home = tempDir(t, 'cowcat-memalw-home-');
  const cwd = tempDir(t, 'cowcat-memalw-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  writeJson(join(home, '.cowcat', 'trust.json'), { trusted: [cwd] });

  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c_first', name: 'Remember', input: { target: 'instructions-project', content: 'first lesson' } } }],
    [{ type: 'tool_call', call: { callId: 'c_second', name: 'Remember', input: { target: 'instructions-project', content: 'second lesson' } } }],
    [{ type: 'text', text: 'both remembered' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_memalw');
  await fixture.client.openSession('sess_memalw');
  await fixture.client.sendTurn('sess_memalw', 'distill two lessons');
  await fixture.until('the first write approval', () =>
    fixture.events().some((e) => e.type === 'approval.requested' && field(e, 'name') === 'Remember'),
  );
  const ask = first(fixture.events(), 'approval.requested');
  await fixture.client.respondApproval('sess_memalw', field(ask, 'callId') as string, 'always');
  await fixture.until('the turn to complete', () =>
    fixture.events().some((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed'),
  );

  assert.equal(
    fixture.events().filter((e) => e.type === 'approval.requested' && field(e, 'name') === 'Remember').length,
    1,
    'the second write to the same target was covered by the grant',
  );
  const written = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(written, /first lesson/);
  assert.match(written, /second lesson/);
});

test('a user turn arriving while the reflect turn runs is queued until it completes', async (t) => {
  const home = tempDir(t, 'cowcat-membusy-home-');
  const cwd = tempDir(t, 'cowcat-membusy-proj-');
  writeUserConfig(home, { model: { preset: PRESET }, memory: { reflect: 'on' } });

  // Turn 1 completes; the reflect turn then calls Remember (user target needs no
  // trust) and parks on the approval — that is the window the user send arrives in.
  const model = new ScriptedModel([
    [{ type: 'text', text: 'task finished' }],
    [{ type: 'tool_call', call: { callId: 'c_refmem', name: 'Remember', input: { target: 'instructions-user', content: 'reflect lesson' } } }],
    [{ type: 'text', text: 'reflected' }],
    [{ type: 'text', text: 'user turn two answer' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());

  await fixture.client.initialize();
  await fixture.client.createSession('sess_membusy');
  await fixture.client.openSession('sess_membusy');
  await fixture.client.sendTurn('sess_membusy', 'do the task');
  await fixture.until('the reflect turns write approval', () =>
    fixture.events().some((e) => e.type === 'approval.requested' && field(e, 'name') === 'Remember'),
  );

  const queued = await fixture.client.request('turn.send', { sessionId: 'sess_membusy', input: 'second user turn' });
  assert.equal(queued.queued, true);

  const ask = first(fixture.events(), 'approval.requested');
  await fixture.client.respondApproval('sess_membusy', field(ask, 'callId') as string, 'once');
  await fixture.until('the reflect turn to complete', () =>
    fixture.events().filter((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed').length >= 2,
  );
  await fixture.until('the queued user turn to complete', () =>
    fixture.events().filter((e) => e.type === 'turn.transitioned' && field(e, 'to') === 'completed').length >= 3,
  );
  assert.match(readFileSync(join(home, '.cowcat', 'AGENTS.md'), 'utf8'), /reflect lesson/);
});

test('model selection is per-session and a failed change preserves the old selection', async (t) => {
  const home = tempDir(t, 'cowcat-model-home-');
  const cwd = tempDir(t, 'cowcat-model-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const model = new ScriptedModel([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]]);
  const fixture = await start({ cwd, home, model, env: { OPENAI_API_KEY: 'test-key' } });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_model_a');
  await fixture.client.createSession('sess_model_b');
  await fixture.client.openSession('sess_model_a');
  await fixture.client.openSession('sess_model_b');

  const initial = await fixture.client.listModels('sess_model_a');
  assert.equal(initial.current.id, PRESET);
  assert.ok(initial.models.some((item) => item.id === 'openai/gpt-6.1-sol'));
  await fixture.client.setModel('sess_model_a', 'openai/gpt-6.1-sol');
  assert.equal((await fixture.client.listModels('sess_model_a')).current.id, 'openai/gpt-6.1-sol');
  assert.equal((await fixture.client.listModels('sess_model_b')).current.id, PRESET);
  await assert.rejects(fixture.client.setModel('sess_model_a', 'missing/nope'), /unknown model preset/);
  assert.equal((await fixture.client.listModels('sess_model_a')).current.id, 'openai/gpt-6.1-sol');
  await assert.rejects(fixture.client.setModel('sess_model_a', 'anthropic/claude-opus-5-5'), /API_KEY|API key|api key|key/);
  assert.equal((await fixture.client.listModels('sess_model_a')).current.id, 'openai/gpt-6.1-sol');

  await fixture.client.sendTurn('sess_model_a', 'first');
  await fixture.client.sendTurn('sess_model_b', 'second');
  await fixture.until('both turns to complete', () => fixture.events().filter((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed').length >= 2);
  const opened = fixture.events().filter((event) => event.type === 'turn.opened');
  assert.equal(field(opened.find((event) => event.sessionId === 'sess_model_a'), 'model'), 'gpt-6.1-sol');
  assert.equal(field(opened.find((event) => event.sessionId === 'sess_model_b'), 'model'), 'claude-sonnet-5-5');
});

test('manual compaction refreshes project instructions and preserves model selection', async (t) => {
  const home = tempDir(t, 'cowcat-compact-home-');
  const cwd = tempDir(t, 'cowcat-compact-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  writeFileSync(join(cwd, 'AGENTS.md'), 'Follow the project rule.\n');
  const model = new ScriptedModel([[{ type: 'text', text: 'older answer '.repeat(10_000) }], [{ type: 'text', text: 'summary' }]]);
  const fixture = await start({ cwd, home, model, env: { OPENAI_API_KEY: 'test-key' }, trustStore: { load: () => Promise.resolve({ trusted: [cwd], problem: null }) } });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_compact');
  await fixture.client.openSession('sess_compact');
  await fixture.client.sendTurn('sess_compact', 'start');
  await fixture.until('the first turn to complete', () => fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'));
  assert.equal(fixture.events().filter((event) => event.type === 'instructions.loaded').length, 1);

  const result = await fixture.client.compactSession('sess_compact');
  assert.equal(result.compacted, true);
  assert.ok(result.dropped > 0);
  assert.equal(fixture.events().filter((event) => event.type === 'instructions.loaded').length, 2);
  assert.equal(fixture.events().filter((event) => event.type === 'context.compacted' && field(event, 'trigger') === 'manual').length, 1);
  await fixture.client.setModel('sess_compact', 'openai/gpt-6.1-sol');
  assert.equal((await fixture.client.listModels('sess_compact')).current.id, 'openai/gpt-6.1-sol');
});

test('a standing grant can be listed and revoked, so the next write asks again', async (t) => {
  const home = tempDir(t, 'cowcat-grants-home-');
  const cwd = tempDir(t, 'cowcat-grants-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const write = (callId: string) => ({ type: 'tool_call' as const, call: { callId, name: 'Write', input: { file_path: join(cwd, `${callId}.txt`), content: 'x\n' } } });
  const model = new ScriptedModel([[write('c_grant_1')], [{ type: 'text', text: 'first done' }], [write('c_grant_2')], [{ type: 'text', text: 'second done' }]]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_grants');
  await fixture.client.openSession('sess_grants');
  await fixture.client.sendTurn('sess_grants', 'write');
  await fixture.until('the first approval', () => first(fixture.events(), 'approval.requested') !== undefined);
  await fixture.client.respondApproval('sess_grants', 'c_grant_1', 'always');
  await fixture.until('the first turn to complete', () => fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'));

  const listed = await fixture.client.listGrants('sess_grants');
  assert.equal(listed.grants.length, 1);
  const [grant] = listed.grants;
  assert.ok(grant !== undefined);
  assert.equal(grant.verdict, 'always');
  const id = grant.id;
  assert.equal(await fixture.client.revokeGrant('sess_grants', id), true);
  assert.equal(await fixture.client.revokeGrant('sess_grants', id), false);
  assert.equal((await fixture.client.listGrants('sess_grants')).grants.length, 0);

  await fixture.client.sendTurn('sess_grants', 'write again');
  await fixture.until('the post-revocation approval', () => fixture.events().filter((event) => event.type === 'approval.requested').length >= 2);
  await fixture.client.respondApproval('sess_grants', 'c_grant_2', 'once');
  await fixture.until('the second turn to complete', () => fixture.events().filter((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed').length >= 2);
  assert.equal(fixture.events().filter((event) => event.type === 'approval.requested').length, 2);
});

test('a second turn queues with a reserved id and starts after the current turn completes', async (t) => {
  const home = tempDir(t, 'cowcat-queue-home-');
  const cwd = tempDir(t, 'cowcat-queue-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const model = new SlowStartModel();
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_queue');
  await fixture.client.openSession('sess_queue');
  await fixture.client.sendTurn('sess_queue', 'first');
  const queued = await fixture.client.request('turn.send', { sessionId: 'sess_queue', input: 'second' });
  assert.equal(queued.queued, true);
  const queuedId = queued.turnId;

  await fixture.until('the queued turn to complete', () => fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed' && event.turnId === queuedId));
  const opened = fixture.events().find((event) => event.type === 'turn.opened' && event.turnId === queuedId);
  assert.ok(opened !== undefined);
  assert.equal(field(opened, 'input'), 'second');
});

test('cancelling removes queued turns before they can emit any session event', async (t) => {
  const home = tempDir(t, 'cowcat-queue-cancel-home-');
  const cwd = tempDir(t, 'cowcat-queue-cancel-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const model = new FirstHangingModel();
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_queue_cancel');
  await fixture.client.openSession('sess_queue_cancel');
  await fixture.client.sendTurn('sess_queue_cancel', 'first');
  const queued = await fixture.client.request('turn.send', { sessionId: 'sess_queue_cancel', input: 'second' });
  assert.equal(queued.queued, true);
  const queuedId = queued.turnId;
  await fixture.client.cancelTurn('sess_queue_cancel');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fixture.events().some((event) => event.type === 'turn.opened' && event.turnId === queuedId), false);
  assert.equal(fixture.events().some((event) => event.type === 'prompt.attached'), false);
});

test('undo deletes a file created by Write and redo recreates the exact bytes', async (t) => {
  const home = tempDir(t, 'cowcat-undo-new-home-');
  const cwd = tempDir(t, 'cowcat-undo-new-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const target = join(cwd, 'new.txt');
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c_new', name: 'Write', input: { file_path: target, content: 'new content\n' } } }],
    [{ type: 'text', text: 'created' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_undo_new');
  await fixture.client.openSession('sess_undo_new');
  await fixture.client.sendTurn('sess_undo_new', 'create');
  await fixture.until('the first approval', () => first(fixture.events(), 'approval.requested') !== undefined);
  await fixture.client.respondApproval('sess_undo_new', 'c_new', 'once');
  await fixture.until('the turn to complete', () => fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'));
  assert.equal(readFileSync(target, 'utf8'), 'new content\n');

  assert.equal((await fixture.client.undoChange('sess_undo_new')).path, target);
  assert.equal(existsSync(target), false);
  assert.equal((await fixture.client.redoChange('sess_undo_new')).path, target);
  assert.equal(readFileSync(target, 'utf8'), 'new content\n');
});

test('undo restores an edited before-image and redo restores the edited content', async (t) => {
  const home = tempDir(t, 'cowcat-undo-edit-home-');
  const cwd = tempDir(t, 'cowcat-undo-edit-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const target = join(cwd, 'existing.txt');
  writeFileSync(target, 'before\n');
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c_read', name: 'Read', input: { file_path: target } } }],
    [{ type: 'tool_call', call: { callId: 'c_edit', name: 'Edit', input: { file_path: target, old_string: 'before\n', new_string: 'after\n' } } }],
    [{ type: 'text', text: 'edited' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_undo_edit');
  await fixture.client.openSession('sess_undo_edit');
  await fixture.client.sendTurn('sess_undo_edit', 'edit');
  await fixture.until('the edit approval', () => first(fixture.events(), 'approval.requested') !== undefined);
  await fixture.client.respondApproval('sess_undo_edit', 'c_edit', 'once');
  await fixture.until('the turn to complete', () => fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'));
  assert.equal(readFileSync(target, 'utf8'), 'after\n');

  await fixture.client.undoChange('sess_undo_edit');
  assert.equal(readFileSync(target, 'utf8'), 'before\n');
  await fixture.client.redoChange('sess_undo_edit');
  assert.equal(readFileSync(target, 'utf8'), 'after\n');
});

test('undo refuses to overwrite an external edit and multi-level undo/redo follows operation order', async (t) => {
  const home = tempDir(t, 'cowcat-undo-guard-home-');
  const cwd = tempDir(t, 'cowcat-undo-guard-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const target = join(cwd, 'guard.txt');
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c_a', name: 'Write', input: { file_path: target, content: 'A\n' } } }],
    [{ type: 'tool_call', call: { callId: 'c_read_ab', name: 'Read', input: { file_path: target } } }],
    [{ type: 'tool_call', call: { callId: 'c_b', name: 'Write', input: { file_path: target, content: 'B\n' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const fixture = await start({ cwd, home, model });
  t.after(() => fixture.close());
  await fixture.client.initialize();
  await fixture.client.createSession('sess_undo_guard');
  await fixture.client.openSession('sess_undo_guard');
  await fixture.client.sendTurn('sess_undo_guard', 'write A then B');
  await fixture.until('the first approval', () => first(fixture.events(), 'approval.requested') !== undefined);
  await fixture.client.respondApproval('sess_undo_guard', 'c_a', 'once');
  await fixture.until('the second approval', () => fixture.events().filter((event) => event.type === 'approval.requested').length >= 2);
  await fixture.client.respondApproval('sess_undo_guard', 'c_b', 'once');
  await fixture.until('the turn to complete', () => fixture.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'));

  writeFileSync(target, 'external\n');
  await assert.rejects(fixture.client.undoChange('sess_undo_guard'), /changed after CowCat wrote it/);
  assert.equal(readFileSync(target, 'utf8'), 'external\n');

  writeFileSync(target, 'B\n');
  await fixture.client.undoChange('sess_undo_guard');
  assert.equal(readFileSync(target, 'utf8'), 'A\n');
  await fixture.client.undoChange('sess_undo_guard');
  assert.equal(existsSync(target), false);
  await fixture.client.redoChange('sess_undo_guard');
  assert.equal(readFileSync(target, 'utf8'), 'A\n');
  await fixture.client.redoChange('sess_undo_guard');
  assert.equal(readFileSync(target, 'utf8'), 'B\n');
});
