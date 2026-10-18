import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Session,
  createEditTool,
  createReadTool,
  createWriteTool,
  nodeFs,
  runTurn,
  type KernelEvent,
  type ToolGrant,
  type ToolPort,
  type ToolResult,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

const signal = new AbortController().signal;
const noGrant: ToolGrant = { networkApproved: false };

function tree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-write-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

const write = async (root: string, input: Record<string, unknown>): Promise<ToolResult> =>
  createWriteTool({ cwd: root }).run(input, signal, noGrant);
const edit = async (root: string, input: Record<string, unknown>): Promise<ToolResult> =>
  createEditTool({ cwd: root }).run(input, signal, noGrant);

// The gate lives in the kernel, so the cases that are about it go through runTurn.
// `nodeFs` rather than the fake: `exists()` is the half of the rule that decides
// "creating" vs "overwriting", and faking it would test the fake.
async function runCalls(root: string, calls: readonly { callId: string; name: string; input: unknown }[], tools: readonly ToolPort[], sessionId = 'sess_write_edit') {
  const model = new ScriptedModel([
    calls.map((call) => ({ type: 'tool_call' as const, call })),
    [{ type: 'text', text: 'done' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), sessionId);
  await runTurn(
    turnDeps(session, model, {
      tools: new Map(tools.map((tool) => [tool.spec.name, tool])),
      fs: nodeFs(),
      approve: () => Promise.resolve('once'),
    }),
    'go',
    signal,
  );
  return { store, session };
}

const finished = (events: readonly KernelEvent[]) =>
  events.filter((event): event is Extract<KernelEvent, { type: 'tool.finished' }> => event.type === 'tool.finished');

test('Write creates missing parent directories and reports created vs updated', async (t) => {
  const root = tree({});
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const created = await write(root, { file_path: 'deep/nested/a.txt', content: 'hello' });
  assert.equal(created.ok, true);
  assert.match(created.output, /^created /);
  assert.equal(readFileSync(join(root, 'deep', 'nested', 'a.txt'), 'utf8'), 'hello');

  const updated = await write(root, { file_path: 'deep/nested/a.txt', content: 'bye' });
  assert.match(updated.output, /^updated /);
  assert.equal(readFileSync(join(root, 'deep', 'nested', 'a.txt'), 'utf8'), 'bye');
});

test('Edit replaces exactly one occurrence when it is unique', async (t) => {
  const root = tree({ 'a.txt': 'one two three\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await edit(root, { file_path: 'a.txt', old_string: 'two', new_string: 'TWO' });

  assert.equal(result.ok, true);
  assert.equal(result.output, `edited ${join(root, 'a.txt')} (1 replacement)`);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one TWO three\n');
});

test('Edit refuses a non-unique old_string and says how many matches there are', async (t) => {
  const root = tree({ 'a.txt': 'x\nx\nx\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await edit(root, { file_path: 'a.txt', old_string: 'x', new_string: 'y' });

  assert.equal(result.ok, false);
  assert.match(result.output, /not unique .*\(3 matches\)/);
  assert.match(result.output, /replace_all=true/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'x\nx\nx\n');
});

test('replace_all replaces every occurrence and reports the count', async (t) => {
  const root = tree({ 'a.txt': 'x\nx\nx\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await edit(root, { file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true });

  assert.equal(result.ok, true);
  assert.equal(result.output, `edited ${join(root, 'a.txt')} (3 replacements)`);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'y\ny\ny\n');
});

test('Edit refuses identical strings and an empty old_string', async (t) => {
  const root = tree({ 'a.txt': 'content\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const identical = await edit(root, { file_path: 'a.txt', old_string: 'content', new_string: 'content' });
  assert.equal(identical.ok, false);
  assert.match(identical.output, /identical; nothing to change/);

  // v1 allowed this: `split('')` inserts the replacement between every character.
  const empty = await edit(root, { file_path: 'a.txt', old_string: '', new_string: 'x' });
  assert.equal(empty.ok, false);
  assert.match(empty.output, /must not be empty/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'content\n');
});

test('a missing old_string on an LF file gets the plain explanation', async (t) => {
  const root = tree({ 'a.txt': 'one\ntwo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await edit(root, { file_path: 'a.txt', old_string: 'nope', new_string: 'x' });

  assert.equal(result.ok, false);
  assert.match(result.output, /old_string not found/);
  assert.equal(result.output.includes('CRLF'), false);
});

test('a missing old_string on a CRLF file names the line endings as the likely cause', async (t) => {
  const root = tree({ 'a.txt': 'one\r\ntwo\r\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // What a model writes after seeing Read's output: the `\r` is invisible.
  const result = await edit(root, { file_path: 'a.txt', old_string: 'one\ntwo', new_string: 'x' });

  assert.equal(result.ok, false);
  assert.match(result.output, /CRLF line endings/);
  assert.match(result.output, /carriage returns/);
});

test('a CRLF file is edited byte-exactly when old_string carries the carriage returns', async (t) => {
  const root = tree({ 'a.txt': 'one\r\ntwo\r\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await edit(root, { file_path: 'a.txt', old_string: 'one\r\n', new_string: 'ONE\r\n' });

  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'ONE\r\ntwo\r\n');
});

test('Edit on a missing file and a directory are ordinary failures', async (t) => {
  const root = tree({ 'dir/keep.txt': 'x' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const missing = await edit(root, { file_path: 'nope.txt', old_string: 'a', new_string: 'b' });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /file not found/);

  const directory = await edit(root, { file_path: 'dir', old_string: 'a', new_string: 'b' });
  assert.equal(directory.ok, false);
  assert.match(directory.output, /is a directory/);
});

test('the kernel refuses to overwrite an existing file that was never read', async (t) => {
  const root = tree({ 'a.txt': 'original\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const writer = createWriteTool({ cwd: root });

  const { store } = await runCalls(root, [{ callId: 'c1', name: 'Write', input: { file_path: join(root, 'a.txt'), content: 'overwritten' } }], [writer]);

  const [result] = finished(store.events);
  assert.ok(result !== undefined);
  assert.equal(result.ok, false);
  assert.match(result.output, /has not been read in this session/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
  // The refusal is still an audited decision, not a silent skip.
  assert.equal(store.events.some((event) => event.type === 'policy.decided'), true);
});

test('creating a new file needs no prior read', async (t) => {
  const root = tree({});
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const writer = createWriteTool({ cwd: root });

  const { store } = await runCalls(root, [{ callId: 'c1', name: 'Write', input: { file_path: join(root, 'new.txt'), content: 'fresh' } }], [writer]);

  assert.equal(finished(store.events)[0]?.ok, true);
  assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'fresh');
});

test('reading a file earlier in the same turn unlocks the overwrite', async (t) => {
  const root = tree({ 'a.txt': 'original\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const reader = createReadTool({ cwd: root });
  const writer = createWriteTool({ cwd: root });

  const { store } = await runCalls(
    root,
    [
      { callId: 'c1', name: 'Read', input: { file_path: join(root, 'a.txt') } },
      { callId: 'c2', name: 'Write', input: { file_path: join(root, 'a.txt'), content: 'overwritten' } },
    ],
    [reader, writer],
  );

  assert.deepEqual(finished(store.events).map((event) => event.ok), [true, true]);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'overwritten');
});

test('reading a different file does not unlock the write', async (t) => {
  const root = tree({ 'a.txt': 'original\n', 'b.txt': 'other\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const reader = createReadTool({ cwd: root });
  const writer = createWriteTool({ cwd: root });

  const { store } = await runCalls(
    root,
    [
      { callId: 'c1', name: 'Read', input: { file_path: join(root, 'b.txt') } },
      { callId: 'c2', name: 'Write', input: { file_path: join(root, 'a.txt'), content: 'overwritten' } },
    ],
    [reader, writer],
  );

  assert.deepEqual(finished(store.events).map((event) => event.ok), [true, false]);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
});

test('the gate survives a reopened session, because readFiles comes from the log', async (t) => {
  const root = tree({ 'a.txt': 'original\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const store = new MemoryEventStore();
  const reader = createReadTool({ cwd: root });
  const writer = createWriteTool({ cwd: root });
  const tools = new Map<string, ToolPort>([
    ['Read', reader],
    ['Write', writer],
  ]);

  const first = await Session.create(sessionDeps(store), 'sess_reopen');
  const firstModel = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Read', input: { file_path: join(root, 'a.txt') } } }],
    [{ type: 'text', text: 'read' }],
  ]);
  await runTurn(turnDeps(first, firstModel, { tools, fs: nodeFs() }), 'read it', signal);
  await first.close();

  // The legacy readSet lived in memory and was empty here; the log is what makes the
  // rule hold (ADR-049).
  const reopened = await Session.open(sessionDeps(store), 'sess_reopen');
  const secondModel = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c2', name: 'Write', input: { file_path: join(root, 'a.txt'), content: 'after reopen' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  await runTurn(turnDeps(reopened, secondModel, { tools, fs: nodeFs() }), 'write it', signal);

  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'after reopen');
});

test('Edit on an existing file is gated the same way as Write', async (t) => {
  const root = tree({ 'a.txt': 'original\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const editor = createEditTool({ cwd: root });

  const { store } = await runCalls(root, [{ callId: 'c1', name: 'Edit', input: { file_path: join(root, 'a.txt'), old_string: 'original', new_string: 'edited' } }], [editor]);

  const [result] = finished(store.events);
  assert.ok(result !== undefined);
  assert.equal(result.ok, false);
  assert.match(result.output, /has not been read in this session/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n');
});

test('after a read, Edit goes through end to end', async (t) => {
  const root = tree({ 'a.txt': 'original\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const reader = createReadTool({ cwd: root });
  const editor = createEditTool({ cwd: root });

  const { store } = await runCalls(
    root,
    [
      { callId: 'c1', name: 'Read', input: { file_path: join(root, 'a.txt') } },
      { callId: 'c2', name: 'Edit', input: { file_path: join(root, 'a.txt'), old_string: 'original', new_string: 'edited' } },
    ],
    [reader, editor],
  );

  assert.deepEqual(finished(store.events).map((event) => event.ok), [true, true]);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'edited\n');
});

test('both tools narrow on file_path', () => {
  assert.equal(createWriteTool({ cwd: '.' }).spec.pathInput, 'file_path');
  assert.equal(createEditTool({ cwd: '.' }).spec.pathInput, 'file_path');
  assert.equal(createWriteTool({ cwd: '.' }).spec.risk, 'write');
  assert.equal(createEditTool({ cwd: '.' }).spec.risk, 'write');
});
