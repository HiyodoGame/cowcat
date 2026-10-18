import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  TODO_MAX_ITEMS,
  createTodoWriteTool,
  replay,
  runTurn,
  type KernelEvent,
  type TodoItem,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

const signal = new AbortController().signal;

const item = (content: string, status: TodoItem['status']): TodoItem => ({
  content,
  status,
  activeForm: `${content}…`,
});

async function runTodo(todos: unknown, sessionId = 'sess_todo') {
  const tool = createTodoWriteTool();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'TodoWrite', input: { todos } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), sessionId);
  await runTurn(
    turnDeps(session, model, { tools: new Map([['TodoWrite', tool]]), approve: () => Promise.resolve('once') }),
    'plan it',
    signal,
  );
  return { store, session };
}

test('the tool reports the list it declared, and the kernel records it as an event', async () => {
  const todos = [item('Add input validation', 'in_progress'), item('Write tests', 'pending')];
  const { store, session } = await runTodo(todos);

  const updated = store.events.find((event: KernelEvent) => event.type === 'todo.updated');
  assert.ok(updated?.type === 'todo.updated');
  assert.deepEqual(updated.todos, todos);
  assert.deepEqual(session.state.todos, todos);
  // The tool has no "was N items": it never read the previous list (ADR-054).
  assert.equal(
    session.state.messages.find((message) => message.role === 'tool')?.output,
    'todo list updated (0/2 completed)',
  );
});

test('the update is written before the tool result it belongs to', async () => {
  const { store } = await runTodo([item('one', 'pending')]);

  const types = store.events.map((event) => event.type);
  const updated = types.indexOf('todo.updated');
  const finished = types.indexOf('tool.finished');
  assert.equal(updated >= 0 && finished >= 0, true);
  // Chosen so a crash between the two appends loses the report, not the user-visible list.
  assert.equal(updated < finished, true);
});

test('the list is replaced wholesale, not merged', async () => {
  const tool = createTodoWriteTool();
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_todo_replace');
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'TodoWrite', input: { todos: [item('first', 'pending'), item('second', 'pending')] } } }],
    [{ type: 'tool_call', call: { callId: 'c2', name: 'TodoWrite', input: { todos: [item('second', 'completed')] } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  await runTurn(
    turnDeps(session, model, { tools: new Map([['TodoWrite', tool]]), approve: () => Promise.resolve('once') }),
    'plan it',
    signal,
  );

  assert.deepEqual(session.state.todos, [item('second', 'completed')]);
  // And a replay of the log agrees with the live state.
  assert.deepEqual(replay('sess_todo_replace', await store.readAll('sess_todo_replace')).todos, session.state.todos);
});

test('a reopened session still has its list, because the list is in the log', async () => {
  const todos = [item('Ship it', 'completed')];
  const { store, session } = await runTodo(todos, 'sess_todo_reopen');
  await session.close();

  const reopened = await Session.open(sessionDeps(store), 'sess_todo_reopen');
  try {
    assert.deepEqual(reopened.state.todos, todos);
  } finally {
    await reopened.close();
  }
});

test('an invalid list is refused as a tool result, and nothing is recorded', async () => {
  const { store, session } = await runTodo([{ content: 'x', status: 'done', activeForm: 'x' }]);

  assert.equal(store.events.some((event) => event.type === 'todo.updated'), false);
  assert.deepEqual(session.state.todos, []);
  const result = session.state.messages.find((message) => message.role === 'tool');
  assert.ok(result !== undefined);
  assert.equal(result.ok, false);
  assert.match(result.output, /todos\[0\]\.status/);
});

test('the list must be non-empty and no longer than 50 items', async () => {
  const empty = await runTodo([], 'sess_todo_empty');
  assert.equal(empty.session.state.messages.find((message) => message.role === 'tool')?.ok, false);

  const many = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, index) => item(`task ${String(index)}`, 'pending'));
  const tooMany = await runTodo(many, 'sess_todo_many');
  assert.equal(tooMany.session.state.messages.find((message) => message.role === 'tool')?.ok, false);

  const exactly = Array.from({ length: TODO_MAX_ITEMS }, (_, index) => item(`task ${String(index)}`, 'pending'));
  const ok = await runTodo(exactly, 'sess_todo_exact');
  assert.equal(ok.session.state.messages.find((message) => message.role === 'tool')?.ok, true);
  assert.equal(ok.session.state.todos.length, TODO_MAX_ITEMS);
});

test('the tool is a write-risk tool with no path and no command to narrow on', () => {
  const spec = createTodoWriteTool().spec;

  assert.equal(spec.risk, 'write');
  assert.equal('pathInput' in spec, false);
  assert.equal('commandInput' in spec, false);
  // Which means DEFAULT_RULES asks about it: the prompt for a mutating action is the
  // default, and ADR-054 leaves "allow it by default" to the composition root.
  assert.deepEqual((spec.inputSchema as Record<string, unknown>).required, ['todos']);
});

test('a tool that reports no todos adds no event', async () => {
  const plain = tool({ name: 'Read', description: 'x', risk: 'read' }, () => ({ ok: true, output: 'x' }));
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Read', input: {} } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_no_todo');
  await runTurn(turnDeps(session, model, { tools: new Map([['Read', plain]]) }), 'go', signal);

  assert.equal(store.events.some((event) => event.type === 'todo.updated'), false);
  assert.deepEqual(session.state.todos, []);
});
