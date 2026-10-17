import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import {
  canTransition,
  DEFAULT_RULES,
  FileSnapshotPort,
  JsonlEventStore,
  reduce,
  replay,
  runTurn,
  SCHEMA_VERSION,
  Session,
  type ActionRequest,
  type KernelEvent,
  type Rule,
  type SessionSnapshot,
  type SessionState,
  type ToolPort,
  type TurnState,
} from '../src/index.js';
import { ScriptedModel, sessionDeps, snapshotsReturning, tool, turnDeps } from './support.js';

// Fixed so any failure can be reproduced exactly; override with COWCAT_PROPERTY_SEED
// to explore other cases. fast-check prints the seed and the shrinking path in its
// failure output, so a failure is reproducible rather than merely reported.
const configuredSeed = Number.parseInt(process.env['COWCAT_PROPERTY_SEED'] ?? '', 10);
const SEED = Number.isNaN(configuredSeed) ? 20_261_017 : configuredSeed;
const RUNS = 60;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cowcat-core-'));
}

// Values a JSON log can hold faithfully... except the last group, which is there on
// purpose: the kernel normalizes tool inputs before recording them, so the property
// has to cover exactly the values JSON cannot represent.
//
// Deliberately NOT fc.jsonValue(): it produces -0, and JSON.stringify(-0) is "0", so
// it would break "replay equals live state" for a reason unrelated to the kernel.
// Measured: 16 of 3000 sampled fc.jsonValue() values fail to survive a JSON round trip.
// fc.dictionary() is used for the same reason from the other side — it builds
// null-prototype objects, and JSON.stringify drops the prototype.
const leaf = fc.oneof(
  fc.boolean(),
  fc.integer(),
  fc.string(),
  fc.constant(null),
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined),
);
const key = fc.stringMatching(/^[a-z]{1,4}$/);
const shallow = fc.oneof(leaf, fc.array(leaf, { maxLength: 3 }), fc.dictionary(key, leaf, { maxKeys: 3 }));
const jsonValue: fc.Arbitrary<unknown> = fc.oneof(
  shallow,
  fc.array(shallow, { maxLength: 2 }),
  fc.dictionary(key, shallow, { maxKeys: 2 }),
);

const toolNames = ['echo_file', 'boom_file', 'write_file', 'missing_tool'] as const;

interface GeneratedScript {
  readonly steps: ReadonlyArray<{ readonly toolName: (typeof toolNames)[number]; readonly input: unknown }>;
  readonly finalText: string;
  readonly approve: boolean;
  readonly denyBoom: boolean;
  readonly abort: boolean;
}

const script: fc.Arbitrary<GeneratedScript> = fc.record({
  steps: fc.array(
    fc.record({
      toolName: fc.constantFrom(...toolNames),
      input: jsonValue,
    }),
    { maxLength: 3 },
  ),
  finalText: fc.string(),
  approve: fc.boolean(),
  denyBoom: fc.boolean(),
  abort: fc.boolean(),
});

const DENY_BOOM: Rule = {
  name: 'no-boom',
  when: { tool: 'boom_file' },
  verdict: 'deny',
  reason: 'boom is never allowed',
};

const tools = new Map<string, ToolPort>([
  ['echo_file', tool({ name: 'echo_file', description: 'echoes', risk: 'read' }, (input) => ({ ok: true, output: JSON.stringify(input) }))],
  ['boom_file', tool({ name: 'boom_file', description: 'throws', risk: 'exec' }, () => {
    throw new Error('boom');
  })],
  ['write_file', tool({ name: 'write_file', description: 'writes', risk: 'write' }, () => ({ ok: true, output: 'written' }))],
]);

// Drives one generated script against a real log and returns the live state, so a
// caller can compare it with whatever reopening the session produces.
async function runScript(
  store: JsonlEventStore,
  generated: GeneratedScript,
): Promise<{ sessionId: string; state: SessionState }> {
  const sessionId = `sess_${randomUUID()}`;
  const session = await Session.create(sessionDeps(store), sessionId);

  const model = new ScriptedModel([
    ...generated.steps.map((step) => [
      {
        type: 'tool_call' as const,
        call: { callId: `call_${randomUUID()}`, name: step.toolName, input: step.input },
      },
    ]),
    [{ type: 'text' as const, text: generated.finalText }],
  ]);

  const controller = new AbortController();
  if (generated.abort) controller.abort();
  await runTurn(
    turnDeps(session, model, {
      tools,
      rules: generated.denyBoom ? [...DEFAULT_RULES, DENY_BOOM] : DEFAULT_RULES,
      approve: () => Promise.resolve(generated.approve ? 'once' : 'reject'),
    }),
    'go',
    controller.signal,
  );

  const state = session.state;
  await session.close();
  return { sessionId, state };
}

test('replaying the log equals the live state, for any turn script', async () => {
  const dir = tempDir();
  try {
    const store = new JsonlEventStore(dir);

    await fc.assert(
      fc.asyncProperty(script, async (generated) => {
        const { sessionId, state } = await runScript(store, generated);

        // Reopen through the real store, which decodes every line with the schema
        // (T2), so this also proves the kernel never writes an event its own decoder
        // would reject.
        const reopened = await Session.open(sessionDeps(store), sessionId);

        assert.deepEqual(reopened.state, state);
        assert.equal(reopened.state.lastSeq, (await store.readAll(sessionId)).length);
        await reopened.close();
      }),
      { seed: SEED, numRuns: RUNS },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot at any point of the log replays to the same state', async () => {
  const dir = tempDir();
  try {
    const store = new JsonlEventStore(dir);

    await fc.assert(
      fc.asyncProperty(script, fc.nat(), async (generated, rawPoint) => {
        const { sessionId, state } = await runScript(store, generated);
        const events = await store.readAll(sessionId);
        // Anywhere in the log, including both ends; a point of 0 means "no events yet".
        const point = rawPoint % (events.length + 1);

        const snapshot: SessionSnapshot = {
          schemaVersion: SCHEMA_VERSION,
          lastSeq: point,
          state: replay(sessionId, events.slice(0, point)),
        };
        const deps = sessionDeps(store, { snapshots: snapshotsReturning(snapshot) });
        const reopened = await Session.open(deps, sessionId);

        assert.deepEqual(reopened.state, state);
        await reopened.close();
      }),
      { seed: SEED, numRuns: RUNS },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged snapshot never changes what the log alone says', async () => {
  const dir = tempDir();
  try {
    const store = new JsonlEventStore(dir);

    await fc.assert(
      fc.asyncProperty(script, fc.string(), async (generated, garbage) => {
        const { sessionId, state } = await runScript(store, generated);
        writeFileSync(join(dir, `${sessionId}.snapshot.json`), garbage, 'utf8');

        const deps = sessionDeps(store, { snapshots: new FileSnapshotPort(dir) });
        const reopened = await Session.open(deps, sessionId);

        assert.deepEqual(reopened.state, state);
        await reopened.close();
      }),
      { seed: SEED, numRuns: RUNS },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ALL_STATES: readonly TurnState[] = [
  'idle',
  'requesting',
  'streaming',
  'awaiting_tools',
  'awaiting_approval',
  'finishing',
  'completed',
  'cancelled',
  'failed',
];

function stateWithTurnIn(state: TurnState): SessionState {
  return { sessionId: 'sess_matrix', lastSeq: 1, turn: { id: 'turn_1', state }, messages: [], grants: [] };
}

function transitionEvent(from: TurnState, to: TurnState): KernelEvent {
  return {
    seq: 2,
    ts: 2,
    sessionId: 'sess_matrix',
    turnId: 'turn_1',
    type: 'turn.transitioned',
    from,
    to,
    reason: null,
  };
}

// Exhaustive rather than sampled: the matrix is 9x9, so checking every pair is both
// cheaper and strictly stronger than drawing random ones (see research §8).
test('every (from, to) pair is accepted exactly when canTransition allows it', () => {
  let allowed = 0;
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (canTransition(from, to)) {
        allowed += 1;
        assert.deepEqual(reduce(stateWithTurnIn(from), transitionEvent(from, to)).turn, {
          id: 'turn_1',
          state: to,
        });
      } else {
        assert.throws(() => reduce(stateWithTurnIn(from), transitionEvent(from, to)), /corrupt log/);
      }
    }
  }

  assert.equal(allowed + (ALL_STATES.length ** 2 - allowed), ALL_STATES.length ** 2);
  assert.ok(allowed > 0 && allowed < ALL_STATES.length ** 2, 'the matrix should not be uniform');
});

test('a transition whose from does not match the live turn is corruption, whatever the pair', () => {
  for (const actual of ALL_STATES) {
    for (const from of ALL_STATES) {
      if (from === actual) continue;
      assert.throws(
        () => reduce(stateWithTurnIn(actual), transitionEvent(from, actual)),
        /corrupt log/,
        `turn is ${actual} but the event claims from ${from}`,
      );
    }
  }
});

test('a transition naming a different turn is rejected', () => {
  const event: KernelEvent = { ...transitionEvent('idle', 'requesting'), turnId: 'turn_other' };

  assert.throws(() => reduce(stateWithTurnIn('idle'), event), /not open/);
});

test('a tool input JSON cannot represent is normalized before it is logged', async () => {
  const dir = tempDir();
  try {
    const store = new JsonlEventStore(dir);
    const deps = sessionDeps(store);
    const session = await Session.create(deps, 'sess_normalized');
    const model = new ScriptedModel([
      [
        {
          type: 'tool_call',
          call: { callId: 'c1', name: 'echo_file', input: { minusZero: -0, dropped: undefined } },
        },
      ],
      [{ type: 'text', text: 'done' }],
    ]);
    await runTurn(
      turnDeps(session, model, { tools }),
      'go',
      new AbortController().signal,
    );

    await session.close();
    const reopened = await Session.open(deps, 'sess_normalized');

    assert.deepEqual(reopened.state, session.state);

    const assistant = reopened.state.messages.find((message) => message.role === 'assistant');
    if (assistant === undefined) assert.fail('expected an assistant message');
    const call = assistant.toolCalls[0];
    if (call === undefined) assert.fail('expected a recorded tool call');
    // -0 became 0 (deepStrictEqual would reject -0) and the undefined key is gone.
    assert.deepEqual(call.input, { minusZero: 0 });

    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an input that cannot be normalized at all fails the turn with a reason', async () => {
  const dir = tempDir();
  try {
    const deps = sessionDeps(new JsonlEventStore(dir));
    const session = await Session.create(deps, 'sess_bigint');
    const model = new ScriptedModel([
      [{ type: 'tool_call', call: { callId: 'c1', name: 'echo_file', input: 10n } }],
      [{ type: 'text', text: 'never reached' }],
    ]);
    const outcome = await runTurn(
      turnDeps(session, model, { tools }),
      'go',
      new AbortController().signal,
    );

    assert.equal(outcome.state, 'failed');
    assert.match(outcome.reason ?? '', /cannot be written to the log/);

    await session.close();
    const reopened = await Session.open(deps, 'sess_bigint');
    assert.deepEqual(reopened.state, session.state);
    assert.equal(reopened.state.turn?.state, 'failed');
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the approve callback receives the request it is deciding', async () => {
  // Guards the generated scripts above: approval is only exercised if the request
  // actually reaches the callback.
  const seen: ActionRequest[] = [];
  const dir = tempDir();
  try {
    const deps = sessionDeps(new JsonlEventStore(dir));
    const session = await Session.create(deps, 'sess_approve');
    const model = new ScriptedModel([
      [{ type: 'tool_call', call: { callId: 'c1', name: 'write_file', input: null } }],
      [{ type: 'text', text: 'done' }],
    ]);
    await runTurn(
      turnDeps(session, model, {
        tools,
        approve: (request) => {
          seen.push(request);
          return Promise.resolve('once');
        },
      }),
      'go',
      new AbortController().signal,
    );

    // `input` is part of the request the approver sees (ADR-027): the card needs the
    // tool's arguments, and this call was generated with a null input.
    assert.deepEqual(seen, [{ kind: 'tool', callId: 'c1', name: 'write_file', risk: 'write', input: null }]);
    await session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
