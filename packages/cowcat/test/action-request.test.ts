// P3 T2a — the kernel is where an ActionRequest is actually built (ADR-027).
//
// T1 added `path?` / `command?` to the request but nothing produced them. These
// cases pin what the kernel does with a tool's `pathInput` / `commandInput`
// declaration, and — more importantly — what it does when the declaration is
// there but the input does not carry a usable value. That case has to end in "no
// path", never in "empty path": a rule selecting on `path` fails closed on an
// absent field, so an empty string would turn a mistyped tool input into a rule
// that matches everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, runTurn, type ActionRequest, type Rule, type ToolPort } from '../src/index.js';
import { MemoryEventStore, ScriptedModel, fakeFs, sessionDeps, tool, turnDeps } from './support.js';

const writer = (pathInput?: string): ToolPort =>
  tool({ name: 'w', description: 'write', risk: 'write', ...(pathInput === undefined ? {} : { pathInput }) }, () => ({ ok: true, output: 'written' }));

const runner = tool({ name: 'sh', description: 'run', risk: 'exec', commandInput: 'command' }, () => ({ ok: true, output: 'ran' }));

// Generates one tool call, then a plain answer so the turn can finish.
const modelFor = (name: string, input: unknown): ScriptedModel =>
  new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name, input } }],
    [{ type: 'text', text: 'done' }],
  ]);

interface RunOptions {
  readonly tools: ToolPort[];
  readonly rules?: readonly Rule[];
  readonly fs?: ReturnType<typeof fakeFs>;
}

async function run(name: string, input: unknown, options: RunOptions) {
  const seen: ActionRequest[] = [];
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_action');
  await runTurn(
    turnDeps(session, modelFor(name, input), {
      tools: new Map(options.tools.map((t) => [t.spec.name, t])),
      ...(options.rules === undefined ? {} : { rules: options.rules }),
      ...(options.fs === undefined ? {} : { fs: options.fs }),
      approve: (request) => {
        seen.push(request);
        return Promise.resolve('once');
      },
    }),
    'go',
    new AbortController().signal,
  );
  return seen;
}

const DENY_UNDER_REPO: Rule = { name: 'deny-repo', when: { path: '/repo' }, verdict: 'deny', reason: 'not here' };
const ASK_NPM: Rule = { name: 'ask-npm', when: { command: 'npm' }, verdict: 'ask', reason: 'needs approval' };

test('a declared pathInput becomes a canonical path on the request', async () => {
  const fs = fakeFs();
  const seen = await run('w', { file_path: 'src\\main.ts' }, { tools: [writer('file_path')], fs });

  assert.deepEqual(fs.canonicalCalls, ['src\\main.ts'], 'the raw spelling is what reaches FsPort');
  const [first] = seen;
  assert.ok(first);
  assert.equal(first.path, 'src/main.ts', 'and the canonical spelling is what a rule compares against');
});

test('a path rule fires on the canonical path', async () => {
  const fs = fakeFs();
  const seen = await run('w', { file_path: '/repo/keep.txt' }, { tools: [writer('file_path')], fs, rules: [DENY_UNDER_REPO] });

  // Denied means the approver was never consulted.
  assert.deepEqual(seen, [], 'a deny never reaches approval');
});

test('a tool is asked about when its path is outside the denied tree', async () => {
  const seen = await run('w', { file_path: '/elsewhere/x.txt' }, { tools: [writer('file_path')], rules: [DENY_UNDER_REPO] });
  assert.equal(seen.length, 1, 'the ask path still reaches approval');
  assert.equal(seen[0]?.path, '/elsewhere/x.txt');
});

test('a declared pathInput with a non-string value yields NO path, so a path rule cannot match', async () => {
  const seen = await run('w', { file_path: 42 }, { tools: [writer('file_path')], rules: [DENY_UNDER_REPO] });

  assert.equal(seen.length, 1, 'the deny must not fire — there is no path to match');
  const [first] = seen;
  assert.ok(first);
  assert.equal(first.path, undefined, 'the field is absent, not present-and-empty');
  assert.ok(!('path' in first), 'absent means an own-property check fails too');
});

test('a declared pathInput with an empty string yields NO path', async () => {
  const seen = await run('w', { file_path: '' }, { tools: [writer('file_path')], rules: [DENY_UNDER_REPO] });
  const [first] = seen;
  assert.ok(first);
  assert.ok(!('path' in first), 'an empty string is not a path');
});

test('a declared pathInput with no such input field yields NO path', async () => {
  const seen = await run('w', { other: 'x' }, { tools: [writer('file_path')], rules: [DENY_UNDER_REPO] });
  assert.equal(seen.length, 1);
});

test('a non-object input yields no path and no crash', async () => {
  // normalizeCall turns `undefined` into null, and a model can ask for anything.
  for (const input of [null, 'a string', 7, undefined]) {
    const seen = await run('w', input, { tools: [writer('file_path')], rules: [DENY_UNDER_REPO] });
    assert.equal(seen.length, 1, `input ${JSON.stringify(input)} must not be denied`);
  }
});

test('a declared commandInput becomes the command on the request', async () => {
  const seen = await run('sh', { command: 'npm run test' }, { tools: [runner], rules: [ASK_NPM] });
  const [first] = seen;
  assert.ok(first);
  assert.equal(first.command, 'npm run test');
});

test('a command rule fires on the declared field', async () => {
  // Same call, but with the default rules: exec is asked about anyway, so instead
  // assert the rule that fires is the command one, by giving the command an allow.
  const allowNpm: Rule = { name: 'allow-npm', when: { command: 'npm' }, verdict: 'allow' };
  const seen = await run('sh', { command: 'npm run test' }, { tools: [runner], rules: [allowNpm] });
  assert.deepEqual(seen, [], 'an allow reaches the tool without asking');
});

test('the command is NOT canonicalised — only paths go through FsPort', async () => {
  const fs = fakeFs();
  await run('sh', { command: './npm   run' }, { tools: [runner], fs });
  assert.deepEqual(fs.canonicalCalls, [], 'FsPort is for paths; a command keeps its exact text');
});

test('a tool declaring neither produces neither field', async () => {
  const seen = await run('w', { file_path: '/repo/x' }, { tools: [writer()] });
  const [first] = seen;
  assert.ok(first);
  assert.deepEqual(Object.keys(first).sort(), ['callId', 'input', 'kind', 'name', 'risk']);
});

test('the request carries the raw input so an approval card can show it', async () => {
  const seen = await run('w', { file_path: '/x', extra: [1, 2] }, { tools: [writer('file_path')] });
  const [first] = seen;
  assert.ok(first);
  assert.deepEqual(first.input, { file_path: '/x', extra: [1, 2] });
});
