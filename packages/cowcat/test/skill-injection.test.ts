import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  replay,
  runTurn,
  Session,
  type KernelEvent,
  type SkillFile,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

/**
 * ADR-116 ④: the catalog is injected once, after the instructions, and put back after a
 * compaction.
 *
 * The property worth testing is who decides it is still there: the fold, through
 * `skillsSeq`. A caller cannot forget to re-inject, and a reopened session cannot inject
 * twice — the same rule ADR-078 established for instructions.
 */

const demo: SkillFile = {
  name: 'demo',
  description: 'A demo skill.',
  path: '/repo/.cowcat/skills/demo/SKILL.md',
  root: '/repo/.cowcat/skills/demo',
  layer: 'project',
  origin: 'cowcat',
  body: 'Do the demo.',
  ignoredFields: [],
  hidden: false,
};

const personal: SkillFile = { ...demo, name: 'personal', layer: 'user', path: '/home/me/.cowcat/skills/personal/SKILL.md' };

function skillsOf(skills: readonly SkillFile[]): { readonly skills: readonly SkillFile[] } {
  return { skills };
}

async function session(): Promise<{ session: Session; store: MemoryEventStore }> {
  const store = new MemoryEventStore();
  return { session: await Session.create(sessionDeps(store), 'sess_skills'), store };
}

const types = (events: readonly KernelEvent[]): readonly string[] => events.map((event) => event.type);

test('the first turn injects the catalog before the user message', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, { skills: { ...skillsOf([demo]), trust: { trusted: true } } });

  const outcome = await runTurn(deps, 'use the demo skill', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.deepEqual(outcome.notes, []);

  assert.deepEqual(types(await store.readAll('sess_skills')).slice(0, 3), [
    'session.opened',
    'skills.loaded',
    'turn.opened',
  ]);

  const request = model.requests[0];
  assert.ok(request !== undefined);
  const first = request.messages[0];
  assert.ok(first !== undefined);
  assert.equal(first.role, 'user');
  assert.match(first.text, /demo: A demo skill\./);
  assert.deepEqual(request.messages[1], { role: 'user', text: 'use the demo skill' });
});

test('the catalog comes after the instructions, not before', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, {
    instructions: {
      port: { chain: async () => [{ name: 'AGENTS.md', path: '/repo/AGENTS.md', content: 'the rules' }] },
      cwd: '/repo',
      trust: { trusted: true },
    },
    skills: { ...skillsOf([demo]), trust: { trusted: true } },
  });

  await runTurn(deps, 'go', new AbortController().signal);
  assert.deepEqual(types(await store.readAll('sess_skills')).slice(0, 4), [
    'session.opened',
    'instructions.loaded',
    'skills.loaded',
    'turn.opened',
  ]);
});

test('a second turn does not inject again, and a reopened session does not either', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]]);
  const deps = turnDeps(s, model, { skills: { ...skillsOf([demo]), trust: { trusted: true } } });

  await runTurn(deps, 'first', new AbortController().signal);
  await runTurn(deps, 'second', new AbortController().signal);

  const events = await store.readAll('sess_skills');
  assert.equal(events.filter((event) => event.type === 'skills.loaded').length, 1);

  const replayed = replay('sess_skills', events);
  assert.notEqual(replayed.skillsSeq, null);
  assert.equal(replayed.skillsCount, 1);
});

test('an untrusted workspace withholds project skills and says why, before the turn opens', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, { skills: { ...skillsOf([demo]), trust: { trusted: false } } });

  const outcome = await runTurn(deps, 'hello', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  const note = outcome.notes[0];
  assert.ok(note !== undefined);
  assert.equal(note.kind, 'skills-skipped');
  assert.match(note.reason, /not trusted/);

  const events = await store.readAll('sess_skills');
  assert.equal(types(events).includes('skills.loaded'), false);
  const noted = events.filter((event) => event.type === 'turn.noted');
  assert.equal(noted.length, 1);
  const first = noted[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, 'turn.noted');
  assert.equal(first.note, 'skills-skipped');
  assert.match(first.message, /技能未加载/u);

  const opened = events.find((event) => event.type === 'turn.opened');
  assert.ok(opened !== undefined);
  assert.ok(first.seq < opened.seq, 'the skip is recorded before the turn opens');
});

test('personal skills still load when the project ones were withheld', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, { skills: { ...skillsOf([personal, demo]), trust: { trusted: false } } });

  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.notes.length, 1, 'the project skip is reported');

  const loaded = (await store.readAll('sess_skills')).filter((event) => event.type === 'skills.loaded');
  assert.equal(loaded.length, 1);
  const event = loaded[0];
  assert.ok(event !== undefined);
  assert.equal(event.type, 'skills.loaded');
  assert.deepEqual(event.skills.map((entry) => entry.name), ['personal']);
  assert.ok(!event.text.includes('- demo:'), 'the withheld project skill is not in the catalog');
});

test('an empty snapshot injects nothing', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([[{ type: 'text', text: 'done' }]]);
  const deps = turnDeps(s, model, { skills: { ...skillsOf([]), trust: { trusted: true } } });

  const outcome = await runTurn(deps, 'hello', new AbortController().signal);
  assert.equal(outcome.state, 'completed');
  assert.deepEqual(outcome.notes, []);
  const events = await store.readAll('sess_skills');
  assert.equal(events.some((event) => event.type === 'skills.loaded'), false);
});

test('a compaction shadows the catalog, and the same turn puts it back after the instructions', async () => {
  const { session: s, store } = await session();
  const model = new ScriptedModel([
    [{ type: 'text', text: '## Objective\nship it\n' }],
    [{ type: 'text', text: 'answered' }],
  ]);
  const deps = turnDeps(s, model, {
    preset: { limits: { output: 1024, context: 400 } },
    instructions: {
      port: { chain: async () => [{ name: 'AGENTS.md', path: '/repo/AGENTS.md', content: 'the rules' }] },
      cwd: '/repo',
      trust: { trusted: true },
    },
    skills: { ...skillsOf([demo]), trust: { trusted: true } },
  });

  const outcome = await runTurn(deps, 'x'.repeat(2_000), new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  const events = await store.readAll('sess_skills');
  const loaded = events.filter((event) => event.type === 'skills.loaded');
  assert.equal(loaded.length, 2, 'once before the turn, once after the compaction');
  const second = loaded[1];
  assert.ok(second !== undefined);
  assert.equal(second.type, 'skills.loaded');
  assert.equal(second.trigger, 'refresh');

  assert.deepEqual(
    types(events).filter((type) => ['instructions.loaded', 'skills.loaded', 'turn.opened', 'context.compacted'].includes(type)),
    ['instructions.loaded', 'skills.loaded', 'turn.opened', 'context.compacted', 'instructions.loaded', 'skills.loaded'],
  );

  const replayed = replay('sess_skills', events);
  assert.notEqual(replayed.skillsSeq, null, 'the refreshed copy is the one that counts');
  assert.equal(replayed.skillsCount, 2);
  const userText = replayed.messages.map((message) => (message.role === 'user' ? message.text : '')).join('\n');
  assert.match(userText, /<summary>/);
  assert.match(userText, /demo: A demo skill\./, 'the catalog is back in the history');
});
