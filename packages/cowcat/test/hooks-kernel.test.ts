import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  compactContext,
  noHooks,
  replay,
  runTurn,
  type HookEventInput,
  type HookRunReport,
  type HooksPort,
  type ModelChunk,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

/**
 * ADR-122 ④: what hooks do to the model's view is a log fact. Denies become `ok:false`
 * tool results, rewrites land in `tool.finished.output`, injected context becomes a
 * `hooks.context-added` user message — and replay reproduces all of it.
 */

const SESSION = 'sess_hooks';

class ScriptedHooks implements HooksPort {
  readonly calls: HookEventInput[] = [];
  constructor(private readonly script: (input: HookEventInput) => HookRunReport) {}

  async run(input: HookEventInput): Promise<HookRunReport> {
    this.calls.push(input);
    return this.script(input);
  }
}

const none: HookRunReport = { outcome: { effect: 'none' }, failures: [] };

const probe: ToolPort = tool({ name: 'Probe', description: 'probe', risk: 'read' }, () => ({
  ok: true,
  output: 'raw output',
}));

function call(callId: string, input: unknown) {
  return { type: 'tool_call' as const, call: { callId, name: 'Probe', input } };
}

async function runWithHooks(
  script: (input: HookEventInput) => HookRunReport,
  modelChunks: readonly (readonly ModelChunk[])[],
) {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), SESSION);
  const hooks = new ScriptedHooks(script);
  const deps = turnDeps(session, new ScriptedModel(modelChunks), {
    tools: new Map([[probe.spec.name, probe]]),
    hooks: { port: hooks, cwd: '/repo' },
  });
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  return { store, session, hooks, outcome };
}

test('PreToolUse deny refuses the call: the tool never runs, the log says why', async () => {
  let ran = 0;
  const counting: ToolPort = tool({ name: 'Probe', description: 'probe', risk: 'read' }, () => {
    ran += 1;
    return { ok: true, output: 'raw output' };
  });
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), SESSION);
  const hooks = new ScriptedHooks((input) =>
    input.event === 'pre-tool-use'
      ? { outcome: { effect: 'deny', reason: 'no probing today' }, failures: [] }
      : none,
  );
  const deps = turnDeps(session, new ScriptedModel([[call('c1', { x: 1 })], [{ type: 'text', text: 'done' }]]), {
    tools: new Map([[counting.spec.name, counting]]),
    hooks: { port: hooks, cwd: '/repo' },
  });
  const outcome = await runTurn(deps, 'go', new AbortController().signal);

  assert.equal(outcome.state, 'completed');
  assert.equal(ran, 0, 'denied call never executed');
  const finished = store.events.find((event) => event.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.equal(finished.ok, false);
  assert.equal(finished.output, 'blocked by hook: no probing today');
  // Replay reproduces the same conversation without the port.
  assert.deepEqual(replay(SESSION, store.events).messages, session.state.messages);
});

test('PostToolUse rewrite is what the log and the model see', async () => {
  const { store, session } = await runWithHooks(
    (input) =>
      input.event === 'post-tool-use'
        ? { outcome: { effect: 'rewrite', output: 'cooked output', note: null }, failures: [] }
        : none,
    [[call('c1', { x: 1 })], [{ type: 'text', text: 'done' }]],
  );

  const finished = store.events.find((event) => event.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.equal(finished.output, 'cooked output', 'tool.finished 记模型所见（ADR-122 ④）');
  const toolMessage = session.state.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage?.role === 'tool');
  assert.equal(toolMessage.output, 'cooked output');
});

test('UserPromptSubmit context lands as a user message before the turn opens', async () => {
  const { store, session } = await runWithHooks(
    (input) =>
      input.event === 'user-prompt-submit'
        ? { outcome: { effect: 'context', text: 'friday rule: no deploys' }, failures: [] }
        : none,
    [[{ type: 'text', text: 'done' }]],
  );

  const added = store.events.find((event) => event.type === 'hooks.context-added');
  assert.ok(added?.type === 'hooks.context-added');
  const opened = store.events.find((event) => event.type === 'turn.opened');
  assert.ok(added.seq < (opened?.seq ?? 0), 'context before the turn, like instructions');
  const messages = session.state.messages;
  assert.ok(messages[0]?.role === 'user' && messages[0].text === 'friday rule: no deploys');
  assert.deepEqual(replay(SESSION, store.events).messages, messages);
});

test('UserPromptSubmit deny refuses the prompt: the model is never called', async () => {
  const { store, hooks, outcome } = await runWithHooks(
    (input) =>
      input.event === 'user-prompt-submit'
        ? { outcome: { effect: 'deny', reason: 'prompt blocked by policy hook' }, failures: [] }
        : none,
    [[{ type: 'text', text: 'unreachable' }]],
  );

  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.reason, 'hook-denied');
  assert.ok(!hooks.calls.some((input) => input.event === 'stop'), 'turn never really ran');
  assert.ok(!store.events.some((event) => event.type === 'model.message'));
  const noted = store.events.find((event) => event.type === 'turn.noted');
  assert.ok(noted?.type === 'turn.noted');
  assert.match(noted.message, /prompt 被 hook 拒绝/);
});

test('the Stop hook fires on normal completion; its failures become notes', async () => {
  const { store, hooks, outcome } = await runWithHooks(
    (input) => (input.event === 'stop' ? { outcome: { effect: 'none' }, failures: ['hook exploded'] } : none),
    [[{ type: 'text', text: 'done' }]],
  );

  assert.equal(outcome.state, 'completed');
  assert.ok(hooks.calls.some((input) => input.event === 'stop'));
  const noted = store.events.find((event) => event.type === 'turn.noted');
  assert.ok(noted?.type === 'turn.noted' && noted.note === 'hook-failed');
  assert.match(noted.message, /hook exploded/);
});

test('turns without the hooks port never call it (omitted means none)', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), SESSION);
  const deps = turnDeps(session, new ScriptedModel([[{ type: 'text', text: 'done' }]]));
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.equal(noHooks.run({ event: 'stop', sessionId: 's', cwd: '/' }, new AbortController().signal) instanceof Promise, true);
});

test('PreCompact fires through compactContext only when a compaction will run', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), SESSION);
  for (let index = 0; index < 6; index += 1) {
    await session.openTurn(`m${String(index)}`);
    await session.emit({
      type: 'model.message',
      turnId: session.turnId,
      text: `answer ${String(index)}`,
      toolCalls: [],
      reasoning: [],
      stopReason: null,
    });
    await session.transition('streaming');
    await session.transition('finishing');
    await session.transition('completed');
  }
  const hooks = new ScriptedHooks(() => none);
  await compactContext(
    {
      session,
      model: new ScriptedModel([
        [{ type: 'text', text: 'summary' }, { type: 'usage', usage: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 } }],
      ]),
      preset: { protocol: 'openai', model: 'test-model', limits: { output: 1024 }, toolCalls: false },
      tools: [],
      keepTokens: 5,
      hooks: { port: hooks, cwd: '/repo' },
    },
    'manual',
    new AbortController().signal,
  );

  assert.deepEqual(hooks.calls.map((input) => input.event), ['pre-compact']);
  assert.equal(hooks.calls[0]?.trigger, 'manual');

  // Nothing to compact → no hook, matching "announce only what will run": a keep
  // window far above the history makes selectTailStart return 0 before anything fires.
  const quiet = new ScriptedHooks(() => none);
  await compactContext(
    {
      session,
      model: new ScriptedModel([]),
      preset: { protocol: 'openai', model: 'test-model', limits: { output: 1024 }, toolCalls: false },
      tools: [],
      keepTokens: 500,
      hooks: { port: quiet, cwd: '/repo' },
    },
    'manual',
    new AbortController().signal,
  );
  assert.equal(quiet.calls.length, 0);
});

test('hook failures never fail the turn (ADR-121 ③)', async () => {
  const { outcome } = await runWithHooks(
    (input) =>
      input.event === 'pre-tool-use' ? { outcome: { effect: 'none' }, failures: ['spawn failed'] } : none,
    [[call('c1', { x: 1 })], [{ type: 'text', text: 'done' }]],
  );
  assert.equal(outcome.state, 'completed');
});
