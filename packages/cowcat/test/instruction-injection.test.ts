import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  replay,
  runTurn,
  Session,
  type InstructionFile,
  type InstructionPort,
  type KernelEvent,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

/**
 * ADR-078: instructions are injected once, and put back after a compaction.
 *
 * The interesting property is not "the text arrived" but **who decides it is still
 * there**: the fold does. `instructionsSeq` is set by the event and cleared by the
 * compaction that shadows it, so a caller cannot forget to re-inject and a reopened
 * session cannot inject twice.
 */

const RULES = '# Rules\n\n- run the tests\n';

function port(files: readonly InstructionFile[]): InstructionPort & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    chain: async () => {
      calls += 1;
      return files;
    },
  };
}

const oneFile: readonly InstructionFile[] = [{ name: 'AGENTS.md', path: '/repo/AGENTS.md', content: RULES.trim() }];

async function session(): Promise<{ session: Session; store: MemoryEventStore }> {
  const store = new MemoryEventStore();
  return { session: await Session.create(sessionDeps(store), 'sess_instr'), store };
}

const types = (events: readonly KernelEvent[]): readonly string[] => events.map((event) => event.type);

test('the first turn injects the instructions before the user message', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, {
    instructions: { port: port(oneFile), cwd: '/repo', trust: { trusted: true } },
  });

  const outcome = await runTurn(deps, 'fix the bug', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.deepEqual(outcome.notes, []);

  assert.deepEqual(types(await store.readAll('sess_instr')).slice(0, 3), [
    'session.opened',
    'instructions.loaded',
    'turn.opened',
  ]);

  // What the model was sent, in order: the rules, then the request.
  const request = model.requests[0];
  assert.ok(request !== undefined);
  const first = request.messages[0];
  assert.ok(first !== undefined);
  assert.match(first.role === 'user' ? first.text : '', /run the tests/);
  assert.equal(first.role, 'user', 'the rules come first');
  assert.deepEqual(request.messages[1], { role: 'user', text: 'fix the bug' });
});

test('a second turn does not inject again, and a reopened session does not either', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]]);
  const reader = port(oneFile);
  const deps = turnDeps(s, model, { instructions: { port: reader, cwd: '/repo', trust: { trusted: true } } });

  await runTurn(deps, 'first', new AbortController().signal);
  await runTurn(deps, 'second', new AbortController().signal);

  const events = await store.readAll('sess_instr');
  assert.equal(events.filter((event) => event.type === 'instructions.loaded').length, 1);
  assert.equal(reader.calls, 1, 'the chain is not even read a second time');

  // The same log replays into a state that already knows the instructions are present.
  const replayed = replay('sess_instr', events);
  assert.notEqual(replayed.instructionsSeq, null);
  assert.equal(replayed.instructionsCount, 1);
});

test('an untrusted workspace injects nothing and says why', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, {
    instructions: { port: port(oneFile), cwd: '/repo', trust: { trusted: false } },
  });

  const outcome = await runTurn(deps, 'hello', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.notes.length, 1);
  const note = outcome.notes[0];
  assert.ok(note !== undefined);
  assert.match(note.kind === 'instructions-skipped' ? note.reason : '', /not trusted/);
  assert.equal(note.kind, 'instructions-skipped');

  const events = await store.readAll('sess_instr');
  assert.equal(types(events).includes('instructions.loaded'), false);

  // ADR-093: the skip is a durable fact, not only a return value. A frontend that sees
  // nothing but the log has to be able to learn why the repository's rules are missing.
  const noted = events.filter((event) => event.type === 'turn.noted');
  assert.equal(noted.length, 1);
  const first = noted[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, 'turn.noted');
  assert.equal(first.note, 'instructions-skipped');
  assert.match(first.message, /工作区指令未注入/u);
  assert.match(first.message, /not trusted/u);

  // Emitted at the moment it happens, not after the turn settles (ADR-093): `run`
  // unsubscribes on the terminal transition, so a note written afterwards is invisible
  // to it — found by the end-to-end check that motivated this test.
  const opened = events.find((event) => event.type === 'turn.opened');
  assert.ok(opened !== undefined);
  assert.ok(first.seq < opened.seq, 'the skip is recorded before the turn opens');
});

test('a broken reader is reported, never fatal', async () => {
  const { session: s } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const failing: InstructionPort = {
    chain: () => Promise.reject(new Error('EACCES')),
  };
  const deps = turnDeps(s, model, { instructions: { port: failing, cwd: '/repo', trust: { trusted: true } } });

  const outcome = await runTurn(deps, 'hello', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  const note = outcome.notes[0];
  assert.ok(note !== undefined && note.kind === 'instructions-skipped');
  assert.match(note.reason, /EACCES/);
});

test('a compaction shadows the instructions, and the same turn puts them back', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([
    // 1: the summary. 2: the answer, after compaction.
    [{ type: 'text', text: '## Objective\nship it\n' }],
    [{ type: 'text', text: 'answered' }],
  ]);
  const deps = turnDeps(s, model, {
    preset: { limits: { output: 1024, context: 400 } },
    instructions: { port: port(oneFile), cwd: '/repo', trust: { trusted: true } },
  });

  const outcome = await runTurn(deps, 'x'.repeat(2_000), new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  const events = await store.readAll('sess_instr');
  const loaded = events.filter((event) => event.type === 'instructions.loaded');
  assert.equal(loaded.length, 2, 'once before the turn, once after the compaction');
  const second = loaded[1];
  assert.ok(second !== undefined);
  assert.equal(second.trigger, 'refresh');

  // The order in the log: instructions, turn, compaction, instructions again.
  assert.deepEqual(
    types(events).filter((type) => ['instructions.loaded', 'turn.opened', 'context.compacted'].includes(type)),
    ['instructions.loaded', 'turn.opened', 'context.compacted', 'instructions.loaded'],
  );

  const replayed = replay('sess_instr', events);
  assert.notEqual(replayed.instructionsSeq, null, 'the refreshed copy is the one that counts');
  assert.equal(replayed.instructionsCount, 2);
  const userText = replayed.messages.map((message) => (message.role === 'user' ? message.text : '')).join('\n');
  assert.match(userText, /<summary>/, 'the compaction summary is in the history');
  assert.match(userText, /run the tests/, 'and so are the refreshed instructions');
});
