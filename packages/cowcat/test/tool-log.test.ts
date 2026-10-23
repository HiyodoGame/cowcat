import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  replay,
  runTurn,
  type ActionRequest,
  type ApprovalVerdict,
  type KernelEvent,
  type ToolGrant,
  type ToolPort,
  type ToolResult,
  type ToolSpec,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

const SESSION = 'sess_tool_log';

// One tool call, then a plain answer so the turn can finish.
const modelFor = (calls: readonly { callId: string; name: string; input: unknown }[]): ScriptedModel =>
  new ScriptedModel([
    calls.map((call) => ({ type: 'tool_call' as const, call })),
    [{ type: 'text', text: 'done' }],
  ]);

interface RunOptions {
  readonly tools: readonly ToolPort[];
  readonly input?: string;
  readonly approve?: (request: ActionRequest) => Promise<ApprovalVerdict>;
}

async function run(calls: readonly { callId: string; name: string; input: unknown }[], options: RunOptions) {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), SESSION);
  const deps = turnDeps(session, modelFor(calls), {
    tools: new Map(options.tools.map((t) => [t.spec.name, t])),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  const outcome = await runTurn(deps, options.input ?? 'go', new AbortController().signal);
  return { store, session, outcome };
}

const finished = (events: readonly KernelEvent[]) => {
  const event = events.find((e) => e.type === 'tool.finished');
  assert.ok(event?.type === 'tool.finished', 'expected a tool.finished event');
  return event;
};

test('a reported truncation reaches the log as a fact, not only as prose in the output', async () => {
  const truncating = tool(
    { name: 'Read', description: 'read', risk: 'read', pathInput: 'file_path' },
    () => ({ ok: true, output: 'first line…', truncation: { truncated: true, dropped: 1980, reason: 'read: 2000 lines' } }),
  );
  const { store, session } = await run([{ callId: 'c1', name: 'Read', input: { file_path: '/repo/a.txt' } }], {
    tools: [truncating],
  });

  assert.deepEqual(finished(store.events).truncation, {
    truncated: true,
    dropped: 1980,
    reason: 'read: 2000 lines',
  });
  // The human-readable note stays where the model can see it (ADR-048 decision ③).
  assert.equal(session.state.messages.find((m) => m.role === 'tool')?.output, 'first line…');
});

test('a tool that reports nothing logs both new fields as null, never as absent', async () => {
  const silent = tool({ name: 'silent', description: 'x', risk: 'read' }, () => ({ ok: true, output: 'x' }));
  const { store } = await run([{ callId: 'c1', name: 'silent', input: {} }], { tools: [silent] });

  const event = finished(store.events);
  assert.equal(event.truncation, null);
  assert.equal(event.path, null);
});

test('the logged path is the canonical one from the request that was decided on', async () => {
  const writer = tool(
    { name: 'Write', description: 'write', risk: 'write', pathInput: 'file_path' },
    () => ({ ok: true, output: 'written' }),
  );
  const { store } = await run(
    [{ callId: 'c1', name: 'Write', input: { file_path: 'C:\\repo\\sub\\a.txt' } }],
    { tools: [writer], approve: () => Promise.resolve('once') },
  );

  // fakeFs normalises separators and strips trailing slashes; the point is that the log
  // holds what the policy layer compared, not the raw input string (ADR-017/049).
  assert.equal(finished(store.events).path, 'C:/repo/sub/a.txt');
});

test('a successful read is in the state, and replaying the log agrees with it', async () => {
  const reader = tool(
    { name: 'Read', description: 'read', risk: 'read', pathInput: 'file_path' },
    () => ({ ok: true, output: 'contents' }),
  );
  const { store, session } = await run([{ callId: 'c1', name: 'Read', input: { file_path: '/repo/a.txt' } }], {
    tools: [reader],
  });

  assert.deepEqual(session.state.readFiles, ['/repo/a.txt']);
  assert.deepEqual(replay(SESSION, await store.readAll(SESSION)).readFiles, session.state.readFiles);
});

test('a reopened session still knows which files were read', async () => {
  const reader = tool(
    { name: 'Read', description: 'read', risk: 'read', pathInput: 'file_path' },
    () => ({ ok: true, output: 'contents' }),
  );
  const { store, session } = await run([{ callId: 'c1', name: 'Read', input: { file_path: '/repo/a.txt' } }], {
    tools: [reader],
  });
  await session.close();

  const reopened = await Session.open(sessionDeps(store), SESSION);
  try {
    // This is the whole reason the path is in the log (ADR-049): the legacy in-memory
    // readSet forgot at exactly this moment, and "read before write" silently vanished.
    assert.deepEqual(reopened.state.readFiles, ['/repo/a.txt']);
  } finally {
    await reopened.close();
  }
});

test('only a successful read counts: a failed read and a write of the same path do not', async () => {
  const failingReader = tool(
    { name: 'Read', description: 'read', risk: 'read', pathInput: 'file_path' },
    () => ({ ok: false, output: 'no such file' }),
  );
  const writer = tool(
    { name: 'Write', description: 'write', risk: 'write', pathInput: 'file_path' },
    () => ({ ok: true, output: 'written' }),
  );
  const { session } = await run(
    [
      { callId: 'c1', name: 'Read', input: { file_path: '/repo/missing.txt' } },
      { callId: 'c2', name: 'Write', input: { file_path: '/repo/written.txt' } },
    ],
    { tools: [failingReader, writer], approve: () => Promise.resolve('once') },
  );

  assert.deepEqual(session.state.readFiles, []);
});

// The second read of the same file must not grow the list: the gate is a set, and a
// duplicated entry would make a snapshot or a report lie about how many files were read.
test('reading the same file twice registers it once', async () => {
  const reader = tool(
    { name: 'Read', description: 'read', risk: 'read', pathInput: 'file_path' },
    () => ({ ok: true, output: 'contents' }),
  );
  const { session } = await run(
    [
      { callId: 'c1', name: 'Read', input: { file_path: '/repo/a.txt' } },
      { callId: 'c2', name: 'Read', input: { file_path: '/repo/a.txt' } },
    ],
    { tools: [reader] },
  );

  assert.deepEqual(session.state.readFiles, ['/repo/a.txt']);
});

// ADR-051's whole point: the tool can read what was granted for THIS call. A tool that
// predates the parameter simply ignores the third argument, which is what makes adding
// it safe.
test('the grant says whether this call was approved, and tools that ignore it still work', async () => {
  const seen: ToolGrant[] = [];
  const speculative: ToolPort = {
    spec: { name: 'Bash', description: 'run', risk: 'exec' },
    run: (input: unknown, _signal: AbortSignal, grant: ToolGrant) => {
      seen.push(grant);
      return Promise.resolve({ ok: true, output: String(input) } satisfies ToolResult);
    },
  };
  const legacySpec: ToolSpec = { name: 'Read', description: 'read', risk: 'read' };
  const legacy = tool(legacySpec, () => ({ ok: true, output: 'contents' }));

  const approvedCalls = [
    { callId: 'c1', name: 'Bash', input: 'echo 1' },
    { callId: 'c2', name: 'Read', input: {} },
  ];
  await run(approvedCalls, { tools: [speculative, legacy], approve: () => Promise.resolve('once') });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { networkApproved: true, unsandboxedApproved: false });
});

test('a call that never needed approval reports no grant', async () => {
  const seen: ToolGrant[] = [];
  const reader: ToolPort = {
    spec: { name: 'Read', description: 'read', risk: 'read' },
    run: (_input: unknown, _signal: AbortSignal, grant: ToolGrant) => {
      seen.push(grant);
      return Promise.resolve({ ok: true, output: 'contents' });
    },
  };
  await run([{ callId: 'c1', name: 'Read', input: {} }], { tools: [reader] });

  // "No grant" is not "network is off": a tool whose profile asks for network has to
  // refuse and say so rather than quietly downgrade (ADR-051, ADR-016).
  assert.deepEqual(seen, [{ networkApproved: false, unsandboxedApproved: false }]);
});

test('a standing always carries the grant to later calls in the same session', async () => {
  const seen: ToolGrant[] = [];
  const runner: ToolPort = {
    spec: { name: 'Bash', description: 'run', risk: 'exec' },
    run: (input: unknown, _signal: AbortSignal, grant: ToolGrant) => {
      seen.push(grant);
      return Promise.resolve({ ok: true, output: String(input) });
    },
  };
  const answers = (): Promise<ApprovalVerdict> => Promise.resolve('always');

  await run(
    [
      { callId: 'c1', name: 'Bash', input: 'echo 1' },
      { callId: 'c2', name: 'Bash', input: 'echo 2' },
    ],
    { tools: [runner], approve: answers },
  );

  assert.deepEqual(seen, [{ networkApproved: true, unsandboxedApproved: false }, { networkApproved: true, unsandboxedApproved: false }]);
});
