import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_PLAN_TOOL_NAME,
  PLAN_OPTION_MAX,
  Session,
  formatPlanResult,
  parseExitPlanInput,
  replay,
  runTurn,
  type KernelEvent,
  type PlanChoice,
  type PlanOption,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

/**
 * ADR-124/125: plan mode is a host-enforced read-only constraint folded from the log,
 * and ExitPlan is the kernel's own tool for leaving it through a person's choice.
 */

const SESSION = 'sess_plan';

const readProbe: ToolPort = tool({ name: 'Probe', description: 'read-risk probe', risk: 'read' }, () => ({
  ok: true,
  output: 'read ok',
}));
const writeProbe: ToolPort = tool({ name: 'Scribe', description: 'write-risk probe', risk: 'write' }, () => ({
  ok: true,
  output: 'written',
}));
const execProbe: ToolPort = tool({ name: 'Runner', description: 'exec-risk probe', risk: 'exec' }, () => ({
  ok: true,
  output: 'ran',
}));
const todoLike: ToolPort = tool({ name: 'TodoWrite', description: 'session-local list', risk: 'write' }, () => ({
  ok: true,
  output: 'todos saved',
}));

function call(callId: string, name: string, input: unknown) {
  return { type: 'tool_call' as const, call: { callId, name, input } };
}

async function freshSession(store: MemoryEventStore, sessionId = SESSION) {
  return Session.create(sessionDeps(store), sessionId);
}

async function enablePlanMode(session: Session): Promise<void> {
  await session.emit({ type: 'plan.mode-changed', turnId: null, enabled: true, by: 'user' });
}

// ---------------------------------------------------------------------------
// Input validation

test('parseExitPlanInput: shape, count, and limits', () => {
  assert.equal(parseExitPlanInput(null).ok, false);
  assert.equal(parseExitPlanInput({}).ok, false);
  assert.equal(parseExitPlanInput({ plans: [] }).ok, false);
  const tooMany = { plans: Array.from({ length: PLAN_OPTION_MAX + 1 }, (_, i) => ({ title: `p${String(i)}`, summary: 's' })) };
  const many = parseExitPlanInput(tooMany);
  assert.equal(many.ok, false);
  assert.match(many.reason, /at most/);

  const bad = parseExitPlanInput({ plans: [{ title: '', summary: 'x' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /title/);

  const good = parseExitPlanInput({ plans: [{ title: 'small', summary: 'one file' }, { title: 'big', summary: 'rewrite' }] });
  assert.equal(good.ok, true);
  assert.equal(good.plans.length, 2);
});

test('formatPlanResult: chosen and none, in the words the model reads', () => {
  const plans: readonly PlanOption[] = [
    { title: 'small', summary: 'patch one file' },
    { title: 'big', summary: 'rewrite the module' },
  ];
  const chosen = formatPlanResult({ kind: 'chosen', index: 1 }, plans);
  assert.match(chosen, /plan 2: 《big》/);
  assert.match(chosen, /rewrite the module/);
  assert.match(chosen, /Plan mode is now OFF/);

  const none = formatPlanResult({ kind: 'none', reason: 'too risky' }, plans);
  assert.match(none, /rejected every plan/);
  assert.match(none, /too risky/);
  assert.match(none, /still in plan mode/);
});

// ---------------------------------------------------------------------------
// The gate (ADR-124)

test('the gate matrix: read passes, write/exec refuse, TodoWrite exempt, explicit deny wins', async () => {
  const tools = new Map<string, ToolPort>([
    [readProbe.spec.name, readProbe],
    [writeProbe.spec.name, writeProbe],
    [execProbe.spec.name, execProbe],
    [todoLike.spec.name, todoLike],
  ]);
  const run = async (session: Session, calls: readonly { callId: string; name: string; input: unknown }[]) => {
    const deps = turnDeps(session, new ScriptedModel([calls.map((c) => call(c.callId, c.name, c.input)), [{ type: 'text', text: 'done' }]]), { tools });
    return runTurn(deps, 'go', new AbortController().signal);
  };

  // plan mode OFF: the write probe runs through the normal path (the test harness
  // approves asks with 'once' by default) — the gate is what changes, not the rules.
  const offStore = new MemoryEventStore();
  const off = await freshSession(offStore, 'sess_gate_off');
  const offOutcome = await run(off, [
    { callId: 'c1', name: 'Scribe', input: { file_path: 'a.txt', content: 'x' } },
  ]);
  assert.equal(offOutcome.state, 'completed');
  const offFinished = offStore.events.find((e) => e.type === 'tool.finished');
  assert.ok(offFinished?.type === 'tool.finished' && offFinished.ok, 'without plan mode the write runs');

  // plan mode ON.
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_gate_on');
  await enablePlanMode(session);
  const outcome = await run(session, [
    { callId: 'c1', name: 'Probe', input: { n: 1 } },
    { callId: 'c2', name: 'Scribe', input: { file_path: 'a.txt', content: 'x' } },
    { callId: 'c3', name: 'Runner', input: { command: 'ls' } },
    { callId: 'c4', name: 'TodoWrite', input: { todos: [{ title: 'step 1' }] } },
  ]);
  assert.equal(outcome.state, 'completed');
  const finished = (name: string) => store.events.find((e) => e.type === 'tool.finished' && e.name === name);
  const readResult = finished('Probe');
  assert.ok(readResult?.type === 'tool.finished' && readResult.ok, 'read-risk tool unaffected');
  const writeResult = finished('Scribe');
  assert.ok(writeResult?.type === 'tool.finished' && !writeResult.ok);
  assert.match(writeResult.output, /plan mode/);
  const execResult = finished('Runner');
  assert.ok(execResult?.type === 'tool.finished' && !execResult.ok);
  assert.match(execResult.output, /plan mode/);
  const todoResult = finished('TodoWrite');
  assert.ok(todoResult?.type === 'tool.finished' && todoResult.ok, 'TodoWrite exempt (ADR-124 ⑤)');
  // The gate never reached the approval bridge for the gated tools; TodoWrite (exempt
  // from the gate) still follows the normal rule path, where an unruled write asks.
  const approvals = store.events.filter((e) => e.type === 'approval.requested');
  assert.ok(approvals.every((e) => e.name === 'TodoWrite'));
  assert.equal(approvals.length, 1);
});

test('an explicit deny rule still beats plan mode (deny is never short-circuited)', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_gate_deny');
  await enablePlanMode(session);
  const denyRule = { name: 'probe-banned', when: { tool: 'Probe' }, verdict: 'deny' as const, reason: 'banned by config' };
  const deps = turnDeps(
    session,
    new ScriptedModel([[call('c1', 'Probe', { n: 1 })], [{ type: 'text', text: 'done' }]]),
    { tools: new Map([[readProbe.spec.name, readProbe]]), rules: [denyRule] },
  );
  await runTurn(deps, 'go', new AbortController().signal);
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.ok(!finished.output.includes('plan mode'));
  assert.match(finished.output, /denied by probe-banned: banned by config/);
});

// ---------------------------------------------------------------------------
// ExitPlan (ADR-125)

const twoPlans = [
  { title: 'patch it', summary: 'edit one file, smallest blast radius' },
  { title: 'rewrite it', summary: 'replace the module, more work now, less debt later' },
];

function exitPlanCall(callId: string, plans: unknown = twoPlans) {
  return call(callId, EXIT_PLAN_TOOL_NAME, { plans });
}

test('ExitPlan is not on the wire outside plan mode', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_wire_off');
  let asked: readonly PlanOption[] | null = null;
  const deps = turnDeps(session, new ScriptedModel([[call('c1', EXIT_PLAN_TOOL_NAME, { plans: twoPlans })], [{ type: 'text', text: 'done' }]]), {
    tools: new Map(),
    planReview: (_callId, plans) => {
      asked = plans;
      return Promise.resolve<PlanChoice>({ kind: 'chosen', index: 0 });
    },
  });
  await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(asked, null, 'review bridge never consulted');
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.match(finished.output, /unknown tool/);
});

test('a chosen plan exits plan mode and the tool result carries the winning summary', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_chosen');
  await enablePlanMode(session);
  const asked: { current: readonly PlanOption[] | null } = { current: null };
  const model = new ScriptedModel([
    [exitPlanCall('c1')],
    [call('c2', 'Scribe', { file_path: 'a.txt', content: 'x' })],
    [{ type: 'text', text: 'done' }],
  ]);
  const deps = turnDeps(session, model, {
    tools: new Map([[writeProbe.spec.name, writeProbe]]),
    planReview: (_callId, plans) => {
      asked.current = plans;
      return Promise.resolve<PlanChoice>({ kind: 'chosen', index: 1 });
    },
  });
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  assert.ok(asked.current !== null && asked.current.length === 2, 'the bridge saw the plans');
  // The tool appeared on the wire only because plan mode was on.
  const wireNames = model.requests[0]?.tools.map((spec) => spec.name) ?? [];
  assert.ok(wireNames.includes(EXIT_PLAN_TOOL_NAME));

  // Event order: proposed → decided → mode-changed(plan-approved). lastIndexOf: the
  // mode entry (by the user, before the turn) is also a plan.mode-changed.
  const types = store.events.map((e) => e.type);
  const proposedAt = types.indexOf('plan.proposed');
  const decidedAt = types.indexOf('plan.decided');
  const modeAt = types.lastIndexOf('plan.mode-changed');
  assert.ok(proposedAt >= 0 && decidedAt > proposedAt && modeAt > decidedAt);
  const proposed = store.events[proposedAt];
  assert.ok(proposed?.type === 'plan.proposed' && proposed.plans.length === 2);
  const decided = store.events[decidedAt];
  assert.ok(decided?.type === 'plan.decided' && decided.choice === 1 && decided.reason === null);
  const mode = store.events[modeAt];
  assert.ok(mode?.type === 'plan.mode-changed' && !mode.enabled && mode.by === 'plan-approved');

  // The model was told what won…
  const exitFinished = store.events.find((e) => e.type === 'tool.finished' && e.callId === 'c1');
  assert.ok(exitFinished?.type === 'tool.finished');
  assert.match(exitFinished.output, /plan 2: 《rewrite it》/);
  assert.match(exitFinished.output, /replace the module/);

  // …and the next round already ran outside the gate (write probe executed, not refused).
  assert.equal(session.state.planMode, false);
  const writeFinished = store.events.find((e) => e.type === 'tool.finished' && e.callId === 'c2');
  assert.ok(writeFinished?.type === 'tool.finished' && writeFinished.ok);
  assert.deepEqual(replay('sess_plan_chosen', store.events).planMode, false);
});

test('rejecting every plan keeps plan mode on and hands the reason to the model', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_none');
  await enablePlanMode(session);
  const model = new ScriptedModel([
    [exitPlanCall('c1')],
    [exitPlanCall('c2', [{ title: 'revised', summary: 'addressed the concern' }])],
    [{ type: 'text', text: 'done' }],
  ]);
  let calls = 0;
  const modeAtReview: boolean[] = [];
  const deps = turnDeps(session, model, {
    tools: new Map(),
    planReview: () => {
      calls += 1;
      modeAtReview.push(session.state.planMode);
      return Promise.resolve<PlanChoice>(calls === 1 ? { kind: 'none', reason: 'both touch too many files' } : { kind: 'chosen', index: 0 });
    },
  });
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  const first = store.events.find((e) => e.type === 'tool.finished' && e.callId === 'c1');
  assert.ok(first?.type === 'tool.finished');
  assert.match(first.output, /rejected every plan/);
  assert.match(first.output, /both touch too many files/);
  assert.deepEqual(modeAtReview, [true, true], 'both reviews ran while plan mode was on');

  const second = store.events.find((e) => e.type === 'tool.finished' && e.callId === 'c2');
  assert.ok(second?.type === 'tool.finished');
  assert.match(second.output, /chose plan 1/);
  assert.equal(session.state.planMode, false);
  assert.equal(calls, 2);
});

test('a review timeout answers none, so the turn always moves', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_timeout');
  await enablePlanMode(session);
  const deps = turnDeps(
    session,
    new ScriptedModel([[exitPlanCall('c1')], [{ type: 'text', text: 'done' }]]),
    {
      tools: new Map(),
      approvalTimeoutMs: 30,
      planReview: () => new Promise<PlanChoice>(() => undefined),
    },
  );
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.match(finished.output, /rejected every plan/);
  assert.match(finished.output, /timeout/i);
  assert.equal(session.state.planMode, true);
});

test('a turn aborted mid-review lands cancelled, not parked', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_abort');
  await enablePlanMode(session);
  const controller = new AbortController();
  const deps = turnDeps(
    session,
    new ScriptedModel([[exitPlanCall('c1')], [{ type: 'text', text: 'done' }]]),
    {
      tools: new Map(),
      planReview: () => {
        controller.abort();
        return new Promise<PlanChoice>(() => undefined);
      },
    },
  );
  const outcome = await runTurn(deps, 'go', controller.signal);
  assert.equal(outcome.state, 'cancelled');
  assert.equal(session.state.turn?.state, 'cancelled');
});

test('mode entry mid-session folds and replays', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_replay');
  await enablePlanMode(session);
  assert.equal(session.state.planMode, true);
  const state = replay('sess_plan_replay', store.events);
  assert.equal(state.planMode, true);
  await session.emit({ type: 'plan.mode-changed', turnId: null, enabled: false, by: 'user' });
  assert.equal(replay('sess_plan_replay', store.events as readonly KernelEvent[]).planMode, false);
});

test('an out-of-range choice counts as none: plan mode stays on with a protocol reason', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_oob');
  await enablePlanMode(session);
  const deps = turnDeps(
    session,
    new ScriptedModel([[exitPlanCall('c1')], [{ type: 'text', text: 'done' }]]),
    {
      tools: new Map(),
      planReview: () => Promise.resolve<PlanChoice>({ kind: 'chosen', index: 99 }),
    },
  );
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  const decided = store.events.find((e) => e.type === 'plan.decided');
  assert.ok(decided?.type === 'plan.decided' && decided.choice === null);
  assert.ok(decided.reason !== null && decided.reason.includes('out of range'));
  assert.equal(
    store.events.filter((e) => e.type === 'plan.mode-changed' && e.by === 'plan-approved').length,
    0,
    'no mode exit without a real choice',
  );
  assert.equal(session.state.planMode, true);
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.match(finished.output, /rejected every plan/);
});

test('an unattended session refuses ExitPlan without parking or proposing', async () => {
  const store = new MemoryEventStore();
  const session = await freshSession(store, 'sess_plan_unattended');
  await enablePlanMode(session);
  let asked = false;
  const deps = turnDeps(
    session,
    new ScriptedModel([[exitPlanCall('c1')], [{ type: 'text', text: 'done' }]]),
    {
      tools: new Map(),
      unattended: 'nobody can answer here',
      planReview: () => {
        asked = true;
        return new Promise<PlanChoice>(() => undefined);
      },
    },
  );
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.equal(asked, false, 'the bridge is never consulted');
  assert.equal(store.events.some((e) => e.type === 'plan.proposed'), false);
  const finished = store.events.find((e) => e.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  assert.match(finished.output, /plan review needs a reader/);
  assert.equal(session.state.planMode, true);
});

test('a plan title with a newline is rejected before it can break the card layout', () => {
  const parsed = parseExitPlanInput({ plans: [{ title: 'two\nlines', summary: 'x' }] });
  assert.equal(parsed.ok, false);
  assert.match('reason' in parsed ? parsed.reason : '', /single line/);
});
