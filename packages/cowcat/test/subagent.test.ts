import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  SUBAGENT_REPORT_MAX_CHARS,
  TASK_TOOL_NAME,
  runTurn,
  type ModelChunk,
  type KernelEvent,
  type Rule,
  type SubagentOutcome,
  type SubagentPort,
  type SubagentRequest,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

const end: ModelChunk = { type: 'stop', reason: { kind: 'end', raw: 'end' } };

function textStep(text: string): readonly ModelChunk[] {
  return [{ type: 'text', text }, end];
}

function callStep(name: string, input: unknown, callId = 'call_1'): readonly ModelChunk[] {
  return [
    { type: 'tool_call', call: { callId, name, input } },
    { type: 'stop', reason: { kind: 'toolCalls', raw: 'tool_calls' } },
  ];
}

const taskInput = { description: 'map the parser', prompt: 'find the parser and report its entry points' };

// `filter` with a type predicate, so the rest of a test reads like the log it describes
// instead of asserting the discriminant again on every access.
function eventsOf<T extends KernelEvent['type']>(
  events: readonly KernelEvent[],
  type: T,
): readonly Extract<KernelEvent, { type: T }>[] {
  return events.filter((event): event is Extract<KernelEvent, { type: T }> => event.type === type);
}

function outcomeFor(request: SubagentRequest, overrides: Partial<SubagentOutcome> = {}): SubagentOutcome {
  return {
    sessionId: request.sessionId,
    role: request.role,
    state: 'completed',
    report: 'the parser lives in src/parse.ts',
    turns: 2,
    partial: false,
    usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    reason: null,
    ...overrides,
  };
}

async function setup(
  model: ScriptedModel,
  options: {
    readonly port?: SubagentPort;
    readonly rules?: readonly Rule[];
    readonly tools?: readonly ToolPort[];
    readonly unattended?: string;
  } = {},
): Promise<{ readonly store: MemoryEventStore; readonly deps: ReturnType<typeof turnDeps> }> {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_parent');
  const deps = turnDeps(session, model, {
    tools: new Map((options.tools ?? []).map((t) => [t.spec.name, t])),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.port === undefined ? {} : { subagents: { port: options.port } }),
    ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
  });
  return { store, deps };
}

test('Task is offered to the model only when a delegation port exists (ADR-080 ③)', async () => {
  const alone = new ScriptedModel([textStep('ok')]);
  const noPort = await setup(alone);
  await runTurn(noPort.deps, 'hi', new AbortController().signal);
  assert.deepEqual(
    alone.requests[0]?.tools.map((t) => t.name),
    [],
    'a session with no port must not advertise delegation',
  );

  const port: SubagentPort = { spawn: (request) => Promise.resolve(outcomeFor(request)) };
  const withPort = new ScriptedModel([textStep('ok')]);
  const delegated = await setup(withPort, { port });
  await runTurn(delegated.deps, 'hi', new AbortController().signal);
  const advertised = withPort.requests[0]?.tools;
  assert.ok(advertised !== undefined);
  assert.deepEqual(
    advertised.map((t) => t.name),
    [TASK_TOOL_NAME],
  );
  // Delegation runs something, so its risk is the same category as a command (ADR-080 ①).
  const spec = advertised[0];
  assert.ok(spec !== undefined);
  assert.equal(spec.risk, 'exec');
});

test('a Task call spawns through the port and logs both delegation facts (ADR-079/082)', async () => {
  const seen: SubagentRequest[] = [];
  const port: SubagentPort = {
    spawn: (request) => {
      seen.push(request);
      return Promise.resolve(outcomeFor(request));
    },
  };
  const model = new ScriptedModel([callStep(TASK_TOOL_NAME, taskInput), textStep('done')]);
  const { store, deps } = await setup(model, { port });

  const outcome = await runTurn(deps, 'hi', new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  assert.equal(seen.length, 1);
  const request = seen[0];
  assert.ok(request !== undefined);
  assert.equal(request.description, taskInput.description);
  assert.equal(request.prompt, taskInput.prompt);
  assert.equal(request.role, 'explore', 'the read-only role is the default');
  assert.equal(request.maxTurns, 10);
  assert.match(request.sessionId, /^sess_/);

  const started = eventsOf(store.events, 'subagent.started')[0];
  assert.ok(started !== undefined);
  assert.equal(started.childSessionId, request.sessionId);

  const finished = eventsOf(store.events, 'subagent.finished')[0];
  assert.ok(finished !== undefined);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.ok, true);
  assert.equal(finished.turns, 2);
  assert.deepEqual(finished.usage, { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });

  // The order matters: both facts are written before the tool result the model reads.
  const types = store.events.map((e) => e.type);
  assert.ok(types.indexOf('subagent.started') < types.indexOf('subagent.finished'));
  assert.ok(types.indexOf('subagent.finished') < types.indexOf('tool.finished'));

  const done = eventsOf(store.events, 'tool.finished').find((e) => e.name === TASK_TOOL_NAME);
  assert.ok(done !== undefined);
  assert.equal(done.ok, true);
  assert.match(done.output, /the parser lives in src\/parse\.ts/);
  assert.match(done.output, new RegExp(request.sessionId), 'the report must carry the child session id');
});

test('a report over the budget is clipped and says how much was dropped (ADR-082 ②)', async () => {
  const over = SUBAGENT_REPORT_MAX_CHARS + 25;
  const port: SubagentPort = {
    spawn: (request) => Promise.resolve(outcomeFor(request, { report: 'x'.repeat(over) })),
  };
  const model = new ScriptedModel([callStep(TASK_TOOL_NAME, taskInput), textStep('done')]);
  const { store, deps } = await setup(model, { port });
  await runTurn(deps, 'hi', new AbortController().signal);

  const done = eventsOf(store.events, 'tool.finished').find((e) => e.name === TASK_TOOL_NAME);
  assert.ok(done !== undefined);
  assert.deepEqual(done.truncation, {
    truncated: true,
    dropped: 25,
    reason: `subagent report: ${String(SUBAGENT_REPORT_MAX_CHARS)} characters`,
  });
  assert.match(done.output, /report truncated to fit the delegation budget/);
});

test('a failing spawn is a tool result the model can react to, not a failed turn', async () => {
  const port: SubagentPort = { spawn: () => Promise.reject(new Error('child session could not be created')) };
  const model = new ScriptedModel([callStep(TASK_TOOL_NAME, taskInput), textStep('doing it myself')]);
  const { store, deps } = await setup(model, { port });

  const outcome = await runTurn(deps, 'hi', new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  const done = eventsOf(store.events, 'tool.finished').find((e) => e.name === TASK_TOOL_NAME);
  assert.ok(done !== undefined);
  assert.equal(done.ok, false);
  assert.match(done.output, /child session could not be created/);

  const finished = eventsOf(store.events, 'subagent.finished')[0];
  assert.ok(finished !== undefined);
  assert.equal(finished.state, 'failed');
  assert.equal(finished.turns, 0);
  assert.equal(finished.usage, null);
});

test('cancelling the parent cancels the delegation and records it on both sides of the log', async () => {
  let markStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const port: SubagentPort = {
    spawn: (_request, signal) =>
      new Promise((_resolve, reject) => {
        markStarted();
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      }),
  };
  const model = new ScriptedModel([callStep(TASK_TOOL_NAME, taskInput)]);
  const { store, deps } = await setup(model, { port });
  const controller = new AbortController();

  const running = runTurn(deps, 'hi', controller.signal);
  await started;
  controller.abort();
  const outcome = await running;

  assert.equal(outcome.state, 'cancelled');
  const finished = eventsOf(store.events, 'subagent.finished')[0];
  assert.ok(finished !== undefined);
  assert.equal(finished.state, 'cancelled');
  assert.equal(finished.ok, false);
});

test('an invalid Task call is refused without spawning anything (ADR-080 ①)', async () => {
  let spawned = 0;
  const port: SubagentPort = {
    spawn: (request) => {
      spawned += 1;
      return Promise.resolve(outcomeFor(request));
    },
  };
  const model = new ScriptedModel([callStep(TASK_TOOL_NAME, { description: 'x', prompt: '   ' }), textStep('done')]);
  const { store, deps } = await setup(model, { port });
  await runTurn(deps, 'hi', new AbortController().signal);

  assert.equal(spawned, 0);
  assert.equal(
    store.events.some((e) => e.type === 'subagent.started'),
    false,
  );
  const done = eventsOf(store.events, 'tool.finished').find((e) => e.name === TASK_TOOL_NAME);
  assert.ok(done !== undefined);
  assert.equal(done.ok, false);
  assert.match(done.output, /invalid Task input: prompt is required/);
});

test('an unattended session refuses an ask immediately and says who refused (ADR-081 ③)', async () => {
  let ran = false;
  const write: ToolPort = tool({ name: 'Write', description: 'write', risk: 'write' }, () => {
    ran = true;
    return { ok: true, output: 'should not happen' };
  });
  const model = new ScriptedModel([callStep('Write', { file_path: 'a.txt' }), textStep('done')]);
  const { store, deps } = await setup(model, { tools: [write], unattended: 'sub agents cannot ask a human' });

  const outcome = await runTurn(deps, 'hi', new AbortController().signal);
  assert.equal(outcome.state, 'completed', 'a refusal is not a failed turn');
  assert.equal(ran, false, 'the tool must not run on a refusal');

  const answered = eventsOf(store.events, 'approval.answered')[0];
  assert.ok(answered !== undefined);
  assert.equal(answered.verdict, 'reject');
  assert.equal(answered.by, 'unattended');

  const done = eventsOf(store.events, 'tool.finished').find((e) => e.name === 'Write');
  assert.ok(done !== undefined);
  assert.equal(done.output, 'rejected: sub agents cannot ask a human');
});
