import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RULES,
  Session,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createTodoWriteTool,
  defaultSandboxProfile,
  nodePlatform,
  runTurn,
  type ActionRequest,
  type ApprovalVerdict,
  type KernelEvent,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
  type Rule,
  type ToolPort,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

const signal = new AbortController().signal;

/** Answers like a failing test run, and reports the truncation the gateway would. */
class FailingTestProcess implements ProcessPort {
  readonly commands: string[] = [];

  run(spec: ProcessSpec): Promise<ProcessResult> {
    this.commands.push(spec.argv.join(' '));
    return Promise.resolve({
      exitCode: 1,
      signal: null,
      stdout: 'FAIL src/a.test.ts\n',
      stderr: 'expected 1 to be 2\n',
      truncated: true,
      dropped: { stdout: 4_000, stderr: 0 },
      removedEnv: [],
      ignoredDeny: [],
      sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
      termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    });
  }
}

test('one turn: read, edit, plan, run a command behind an approval, and hit two truncations', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-e2e-')));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const other = 2;\n');

  const process = new FailingTestProcess();
  const platform = nodePlatform();
  const tools: readonly ToolPort[] = [
    createReadTool({ cwd: root }),
    createEditTool({ cwd: root }),
    createGlobTool({ cwd: root }),
    createGrepTool({ cwd: root }),
    createBashTool({ cwd: root, process, platform, sandbox: defaultSandboxProfile({ mode: 'off' }) }),
    createTodoWriteTool(),
  ];

  const model = new ScriptedModel([
    [
      { type: 'tool_call', call: { callId: 'c1', name: 'Read', input: { file_path: join(root, 'src', 'a.ts') } } },
      { type: 'tool_call', call: { callId: 'c2', name: 'Edit', input: { file_path: join(root, 'src', 'a.ts'), old_string: 'value = 1', new_string: 'value = 2' } } },
      { type: 'tool_call', call: { callId: 'c3', name: 'TodoWrite', input: { todos: [{ content: 'Fix the value', status: 'in_progress', activeForm: 'Fixing the value' }] } } },
      { type: 'tool_call', call: { callId: 'c4', name: 'Bash', input: { command: 'npm test' } } },
      // head_limit 1 with two matching files: the default mode must stop early, and the
      // truncation must say the total is unknown (ADR-050/053).
      { type: 'tool_call', call: { callId: 'c5', name: 'Grep', input: { pattern: 'export const', head_limit: 1 } } },
    ],
    [{ type: 'text', text: 'done' }],
  ]);

  const rules: readonly Rule[] = [...DEFAULT_RULES, { name: 'exec-asks', when: { risk: 'exec' }, verdict: 'ask' }];
  const asked: ActionRequest[] = [];
  const approve = (request: ActionRequest): Promise<ApprovalVerdict> => {
    asked.push(request);
    return Promise.resolve('once');
  };

  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_e2e');
  const outcome = await runTurn(turnDeps(session, model, { tools: new Map(tools.map((tool) => [tool.spec.name, tool])), rules, approve }), 'fix the failing test', signal);

  // The turn completed, and the edit is on disk.
  assert.deepEqual(outcome, { turnId: 'turn_1', state: 'completed', reason: null, partial: false, notes: [] });
  assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'export const value = 2;\n');

  // Exactly three questions, in call order: `DEFAULT_RULES` allows reads and nothing
  // else (ADR-034), so the two mutating actions ask — TodoWrite included, which is the
  // known consequence ADR-054 records — and the command asks because of the rule below.
  assert.deepEqual(asked.map((request) => request.name), ['Edit', 'TodoWrite', 'Bash']);
  assert.equal(asked[2]?.command, 'npm test');
  assert.equal(process.commands.length, 1);

  // The list the model declared is the session's list, and the read is registered.
  assert.deepEqual(session.state.todos, [{ content: 'Fix the value', status: 'in_progress', activeForm: 'Fixing the value' }]);
  assert.deepEqual(session.state.readFiles, [join(root, 'src', 'a.ts').replace(/\\/g, '/')]);

  // Five results, in the order they were called.
  const finished = store.events.filter((event): event is Extract<KernelEvent, { type: 'tool.finished' }> => event.type === 'tool.finished');
  assert.deepEqual(finished.map((event) => event.name), ['Read', 'Edit', 'TodoWrite', 'Bash', 'Grep']);

  const [read, edit, todo, bash, grep] = finished;
  assert.ok(read !== undefined && edit !== undefined && todo !== undefined && bash !== undefined && grep !== undefined);
  // A failing command is a result the model interprets, not a failed turn.
  assert.equal(bash.ok, true);
  assert.match(bash.output, /exit code: 1/);
  assert.match(bash.output, /expected 1 to be 2/);

  // Two truncations, and the two are different facts: the gateway knows what it dropped,
  // an early-exiting Grep does not (ADR-048 vs ADR-053).
  assert.deepEqual(bash.truncation, { truncated: true, dropped: 4_000, reason: 'bash: output cap (100000 characters per stream)' });
  assert.deepEqual(grep.truncation, { truncated: true, dropped: null, reason: 'grep: head_limit 1' });

  // The approval left both the question and the answer in the log, in that order.
  const types = store.events.map((event) => event.type);
  assert.equal(types.indexOf('approval.requested') < types.indexOf('approval.answered'), true);
  // The list is recorded before the result of the call that declared it (ADR-054).
  const todoFinished = store.events.findIndex((event) => event.type === 'tool.finished' && event.name === 'TodoWrite');
  assert.equal(types.indexOf('todo.updated') < todoFinished, true);

  // And the whole turn replays to the same state it ended in.
  const replayed = await (async () => {
    await session.close();
    const reopened = await Session.open(sessionDeps(store), 'sess_e2e');
    try {
      return { todos: reopened.state.todos, readFiles: reopened.state.readFiles, messages: reopened.state.messages.length };
    } finally {
      await reopened.close();
    }
  })();
  assert.deepEqual(replayed.todos, session.state.todos);
  assert.deepEqual(replayed.readFiles, session.state.readFiles);
  assert.equal(replayed.messages, session.state.messages.length);
});

test('a denied command never runs, and the model is told which rule denied it', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-e2e-')));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const process = new FailingTestProcess();
  const platform = nodePlatform();
  const bash = createBashTool({ cwd: root, process, platform, sandbox: defaultSandboxProfile({ mode: 'off' }) });
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Bash', input: { command: 'rm -rf /' } } }],
    [{ type: 'text', text: 'understood' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_e2e_deny');
  await runTurn(
    turnDeps(session, model, {
      tools: new Map([['Bash', bash]]),
      rules: [{ name: 'no-recursive-deletes', when: { command: 'rm -rf' }, verdict: 'deny', reason: 'too destructive' }],
    }),
    'clean up',
    signal,
  );

  assert.equal(process.commands.length, 0);
  const finished = store.events.find((event): event is Extract<KernelEvent, { type: 'tool.finished' }> => event.type === 'tool.finished');
  assert.ok(finished !== undefined);
  assert.equal(finished.ok, false);
  assert.match(finished.output, /denied by no-recursive-deletes: too destructive/);
});
