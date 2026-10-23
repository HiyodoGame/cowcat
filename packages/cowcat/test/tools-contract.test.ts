import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeProcess,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createTodoWriteTool,
  createWriteTool,
  defaultSandboxProfile,
  nodePlatform,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
  type ToolGrant,
  type ToolPort,
} from '../src/index.js';

const signal = new AbortController().signal;
const noGrant: ToolGrant = { networkApproved: false, unsandboxedApproved: false };

/** Never reached in this file: every call here is either invalid or answered with `ok`. */
class UnreachableProcess implements ProcessPort {
  run(spec: ProcessSpec): Promise<ProcessResult> {
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: 'ran',
      stderr: '',
      truncated: false,
      dropped: { stdout: 0, stderr: 0 },
      removedEnv: [],
      ignoredDeny: [],
      sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
      termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    });
  }

  open(): Promise<never> {
    return Promise.reject(new Error('UnreachableProcess.open() is not used in this test'));
  }
}

function tools(cwd: string): readonly ToolPort[] {
  return [
    createReadTool({ cwd }),
    createWriteTool({ cwd }),
    createEditTool({ cwd }),
    createGlobTool({ cwd }),
    createGrepTool({ cwd }),
    createBashTool({ cwd, process: new UnreachableProcess(), platform: nodePlatform(), sandbox: defaultSandboxProfile({ mode: 'off' }) }),
    createTodoWriteTool(),
  ];
}

const RISKS = new Set(['read', 'write', 'exec', 'network']);

test('every tool declares a complete spec, and the wire schema is an object without $schema', () => {
  const all = tools('.');

  assert.equal(all.length, 7);
  for (const tool of all) {
    const { spec } = tool;
    assert.equal(spec.name.length > 0, true, 'a tool needs a name');
    assert.equal(spec.description.length > 50, true, `${spec.name} needs a description the model can act on`);
    assert.equal(RISKS.has(spec.risk), true, `${spec.name} has an unknown risk`);

    const schema = spec.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, 'object', `${spec.name} must take an object`);
    assert.equal('$schema' in schema, false, `${spec.name} must not ship $schema`);
    assert.equal(typeof schema.properties, 'object');
  }
});

test('a declared narrowing field is a property of the schema, so rules can match it', () => {
  for (const tool of tools('.')) {
    const schema = tool.spec.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    for (const field of [tool.spec.pathInput, tool.spec.commandInput]) {
      if (field === undefined) continue;
      assert.equal(Object.hasOwn(properties, field), true, `${tool.spec.name}: ${field} is not in the schema`);
    }
  }
});

test('the seven names are the P5 list, and the read tool is named exactly Read', () => {
  const names = tools('.').map((tool) => tool.spec.name).sort();

  assert.deepEqual(names, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoWrite', 'Write']);
  // Not cosmetic: `reduce` registers the read set by tool name, so a rename here would
  // silently disable the read-before-write gate (ADR-049).
  assert.equal(createReadTool({ cwd: '.' }).spec.name, 'Read');
});

test('invalid arguments are a tool result with a field path, never a throw', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-contract-')));
  try {
    for (const tool of tools(cwd)) {
      // Every tool has at least one required field, so `{}` is invalid for all of them.
      const result = await tool.run({}, signal, noGrant);
      assert.equal(result.ok, false, `${tool.spec.name} accepted an empty input`);
      assert.match(result.output, new RegExp(`^invalid input for ${tool.spec.name}:`), tool.spec.name);
      assert.equal(typeof result.truncation, 'undefined', 'a refused call reports no truncation');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('garbage input is refused rather than crashing the turn', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-contract-')));
  try {
    for (const tool of tools(cwd)) {
      for (const garbage of [null, 42, 'text', [], true]) {
        const result = await tool.run(garbage, signal, noGrant);
        assert.equal(result.ok, false, `${tool.spec.name} accepted ${JSON.stringify(garbage)}`);
        assert.match(result.output, /^invalid input for /);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('every tool reports a truncation fact on a call that ran', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-contract-')));
  try {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), 'const value = 1;\n');
    writeFileSync(join(cwd, 'src', 'b.ts'), 'const other = 2;\n');

    const calls: readonly { readonly tool: ToolPort; readonly input: unknown }[] = [
      { tool: createReadTool({ cwd }), input: { file_path: 'src/a.ts' } },
      { tool: createWriteTool({ cwd }), input: { file_path: 'src/new.ts', content: 'x\n' } },
      { tool: createEditTool({ cwd }), input: { file_path: 'src/a.ts', old_string: 'value = 1', new_string: 'value = 9' } },
      { tool: createGlobTool({ cwd }), input: { pattern: '**/*.ts' } },
      { tool: createGrepTool({ cwd }), input: { pattern: 'value' } },
      {
        tool: createBashTool({ cwd, process: new UnreachableProcess(), platform: nodePlatform(), sandbox: defaultSandboxProfile({ mode: 'off' }) }),
        input: { command: 'echo hi' },
      },
      { tool: createTodoWriteTool(), input: { todos: [{ content: 'x', status: 'pending', activeForm: 'x-ing' }] } },
    ];

    for (const { tool, input } of calls) {
      const result = await tool.run(input, signal, noGrant);
      assert.equal(result.ok, true, `${tool.spec.name}: ${result.output}`);
      // The T1 convention, applied to all seven: "asked, nothing dropped" is a fact the
      // audit can use, and it is different from "nobody said" (ADR-048).
      assert.notEqual(result.truncation, undefined, `${tool.spec.name} reported no truncation fact`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the real Bash tool reaches the gateway with the resolved shell, not a shell string', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-contract-')));
  try {
    const platform = nodePlatform();
    const bash = createBashTool({ cwd, process: new NodeProcess({ platform }), platform, sandbox: defaultSandboxProfile({ mode: 'off' }) });
    const result = await bash.run({ command: 'echo contract-ok' }, signal, noGrant);

    assert.equal(result.ok, true);
    assert.match(result.output, /contract-ok/);
    assert.equal(result.facts?.sandbox.mode, 'off');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
