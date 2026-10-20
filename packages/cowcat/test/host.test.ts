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
  type SessionShell,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel } from './support.js';

const PRESET = 'anthropic/claude-sonnet-5-5';

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
}

/** A model whose stream never produces anything until it is cancelled. */
class HangingModel implements ModelPort {
  stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<ModelChunk>>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted by the client'));
            }, { once: true });
          }),
      }),
    };
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
          new Promise<IteratorResult<ModelChunk>>((_resolve, reject) => {
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
  options: { readonly cwd: string; readonly home: string; readonly model: ModelPort } & Pick<
    CreateHostOptions,
    'platform' | 'process' | 'store'
  >,
): Promise<Fixture> {
  const host = await createHost({
    cwd: options.cwd,
    home: options.home,
    env: {},
    version: '0.0.0-test',
    model: options.model,
    approvalTimeoutMs: 5_000,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.store === undefined ? {} : { store: options.store }),
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
  assert.deepEqual(listed, [{ sessionId: 'sess_listed', lastSeq: 1 }]);

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
