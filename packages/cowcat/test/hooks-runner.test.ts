import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_DEFAULT_TIMEOUT_MS,
  compileMatcher,
  createHooksPort,
  loadHookSources,
  matcherMatches,
  parseHookSection,
  defaultSandboxProfile,
  nodePlatform,
  type HookEventInput,
  type HookParseResult,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
} from '../src/index.js';

/**
 * ADR-121/122/123: hooks parse Claude Code settings.json, run through the ProcessPort,
 * and resolve to the four outcome shapes the kernel knows (deny / context / rewrite /
 * none) plus non-blocking failure lines.
 */

const signal = new AbortController().signal;
const platform = nodePlatform();
const sandbox = defaultSandboxProfile({ mode: 'off' });

function resultOf(_spec: ProcessSpec, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    dropped: { stdout: 0, stderr: 0 },
    removedEnv: [],
    ignoredDeny: [],
    sandbox: { mode: 'off', backend: null, limitations: [] },
    termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    ...overrides,
  };
}

/** Each queued result is returned for one run; the last one repeats. */
class ScriptedProcess implements ProcessPort {
  readonly specs: ProcessSpec[] = [];
  constructor(readonly results: ProcessResult[]) {}

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.specs.push(spec);
    const index = Math.min(this.specs.length - 1, this.results.length - 1);
    const result = this.results[index];
    if (result === undefined) throw new Error('ScriptedProcess: no result queued');
    return result;
  }

  async open(): Promise<never> {
    throw new Error('ScriptedProcess.open() is not used in hooks tests');
  }
}

function makePort(parsed: HookParseResult, results: ProcessResult[]) {
  return createHooksPort({
    parsed,
    process: new ScriptedProcess(results),
    platform,
    sandbox,
    projectDir: '/repo',
    sessionsDir: '/sessions',
    env: { PATH: '/usr/bin' },
  });
}

function makePortWith(process: ScriptedProcess, parsed: HookParseResult) {
  return createHooksPort({
    parsed,
    process,
    platform,
    sandbox,
    projectDir: '/repo',
    sessionsDir: '/sessions',
    env: { PATH: '/usr/bin' },
  });
}

const section = (hooks: unknown, source = '/repo/.claude/settings.json') => parseHookSection(hooks, source);

// ---------------------------------------------------------------------------
// Parsing

test('matcher compilation follows the CC rules (ADR-122 ③)', () => {
  assert.deepEqual(compileMatcher('*'), { kind: 'all' });
  assert.deepEqual(compileMatcher(''), { kind: 'all' });
  assert.deepEqual(compileMatcher('Bash'), { kind: 'exact', names: ['Bash'] });
  assert.deepEqual(compileMatcher('Edit|Write'), { kind: 'exact', names: ['Edit', 'Write'] });
  assert.deepEqual(compileMatcher('Edit, Write'), { kind: 'exact', names: ['Edit', 'Write'] });
  assert.deepEqual(compileMatcher('^mcp__.*'), { kind: 'regex', pattern: '^mcp__.*' });
  assert.ok('error' in compileMatcher('('));
});

test('matcherMatches: exact lists, unanchored regex, all', () => {
  assert.equal(matcherMatches(null, 'anything'), true);
  assert.equal(matcherMatches({ kind: 'all' }, 'anything'), true);
  assert.equal(matcherMatches({ kind: 'exact', names: ['Bash'] }, 'Bash'), true);
  assert.equal(matcherMatches({ kind: 'exact', names: ['Bash'] }, 'BashTool'), false);
  assert.equal(matcherMatches({ kind: 'regex', pattern: 'mcp__.*' }, 'mcp__mem__x'), true);
});

test('parse: command handlers compile with defaults; everything else is reported inert', () => {
  const parsed = section({
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh', timeout: 30, if: 'Bash(rm *)' }] },
      { hooks: [{ type: 'http', url: 'http://x' }] },
    ],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint.sh', args: ['--fix'] }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'bye.sh' }] }],
    Bogus: [{ hooks: [{ type: 'command', command: 'x' }] }],
  });

  assert.equal(parsed.hooks.length, 2);
  const first = parsed.hooks[0];
  assert.ok(first !== undefined);
  assert.equal(first.event, 'pre-tool-use');
  assert.equal(first.timeoutMs, 30_000);
  assert.equal(first.matcher?.kind ?? null, 'exact');
  const second = parsed.hooks[1];
  assert.ok(second !== undefined);
  assert.equal(second.args?.[0] ?? null, '--fix');
  assert.equal(HOOK_DEFAULT_TIMEOUT_MS, 60_000);
  assert.equal(second.timeoutMs, HOOK_DEFAULT_TIMEOUT_MS);

  const inert = parsed.inert.join('\n');
  assert.match(inert, /http 类型 handler v1 不执行/);
  assert.match(inert, /"if" 字段解析但不生效/);
  assert.match(inert, /SessionEnd/);
  assert.match(inert, /不支持的 hook 事件 Bogus/);
});

test('parse: a bad regex matcher never matches and is reported', () => {
  const parsed = section({ PreToolUse: [{ matcher: '([', hooks: [{ type: 'command', command: 'x' }] }] });
  assert.equal(parsed.hooks.length, 0);
  assert.match(parsed.inert.join(''), /不是合法正则/);
});

test('parse: a non-object hooks section is one inert line, not a throw', () => {
  const parsed = section('nope');
  assert.equal(parsed.hooks.length, 0);
  assert.equal(parsed.inert.length, 1);
});

// ---------------------------------------------------------------------------
// Execution

const preToolInput: HookEventInput = {
  event: 'pre-tool-use',
  sessionId: 'sess_h',
  cwd: '/repo',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf /tmp/x' },
};

function oneCommand(hooks: unknown): HookParseResult {
  return section(hooks);
}

test('no matching handler spawns nothing and returns none', async () => {
  const process = new ScriptedProcess([]);
  const port = createHooksPort({
    parsed: oneCommand({ PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'x' }] }] }),
    process,
    platform,
    sandbox,
    projectDir: '/repo',
    sessionsDir: '/sessions',
  });
  const report = await port.run(preToolInput, signal);
  assert.deepEqual(report, { outcome: { effect: 'none' }, failures: [] });
  assert.equal(process.specs.length, 0);
});

test('the hook receives the CC input shape on stdin and the session sandbox/cwd', async () => {
  const process = new ScriptedProcess([resultOf({} as ProcessSpec)]);
  const port = makePortWith(
    process,
    oneCommand({ PreToolUse: [{ hooks: [{ type: 'command', command: 'check "${CLAUDE_PROJECT_DIR}"' }] }] }),
  );
  await port.run(preToolInput, signal);

  const spec = process.specs[0];
  assert.ok(spec !== undefined);
  assert.equal(spec.cwd, '/repo');
  assert.equal(spec.env.CLAUDE_PROJECT_DIR, '/repo');
  assert.equal(spec.sandbox.mode, 'off');
  assert.equal(spec.timeoutMs, HOOK_DEFAULT_TIMEOUT_MS);
  // Shell form: the command is one argument to the resolved shell (ADR-014).
  const stdin = JSON.parse(spec.stdin ?? '{}') as Record<string, unknown>;
  assert.equal(stdin.hook_event_name, 'pre-tool-use');
  assert.equal(stdin.session_id, 'sess_h');
  assert.equal(stdin.cwd, '/repo');
  assert.equal(stdin.tool_name, 'Bash');
  assert.deepEqual(stdin.tool_input, { command: 'rm -rf /tmp/x' });
  assert.equal(stdin.permission_mode, undefined, '宁缺毋假：没有的概念不给（ADR-122 ③）');
  assert.equal(String(stdin.transcript_path).replace(/\\/g, '/'), '/sessions/sess_h.jsonl');
  assert.ok(spec.argv[spec.argv.length - 1]?.includes('"/repo"'), 'project dir substituted into the command');
});

test('exit 0 with permissionDecision deny blocks the tool call', async () => {
  const port = makePort(
    oneCommand({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'block' }] }] }),
    [resultOf({} as ProcessSpec, {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no rm' } }),
    })],
  );
  const report = await port.run(preToolInput, signal);
  assert.deepEqual(report.outcome, { effect: 'deny', reason: 'no rm' });
});

test('exit 2 denies with the stderr reason; on observation events it is a failure line', async () => {
  const denyPort = makePort(
    oneCommand({ PreToolUse: [{ hooks: [{ type: 'command', command: 'block' }] }] }),
    [resultOf({} as ProcessSpec, { exitCode: 2, stderr: 'nope\n' })],
  );
  const denied = await denyPort.run(preToolInput, signal);
  assert.deepEqual(denied.outcome, { effect: 'deny', reason: 'nope' });

  const stopPort = makePort(
    oneCommand({ Stop: [{ hooks: [{ type: 'command', command: 'block' }] }] }),
    [resultOf({} as ProcessSpec, { exitCode: 2, stderr: 'nope\n' })],
  );
  const stopped = await stopPort.run({ event: 'stop', sessionId: 's', cwd: '/repo' }, signal);
  assert.equal(stopped.outcome.effect, 'none');
  assert.match(stopped.failures.join(''), /exit 2/);
});

test('exit 1 and timeouts are non-blocking failures; later handlers still run', async () => {
  const port = makePort(
    oneCommand({
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'flaky' }, { type: 'command', command: 'ok' }] },
      ],
    }),
    [
      resultOf({} as ProcessSpec, { exitCode: 1, stderr: 'boom' }),
      resultOf({} as ProcessSpec, { termination: { requested: true, reason: 'timeout', strategy: 'single-process', escalated: false, fallbackUsed: false, residuePossible: false } }),
      resultOf({} as ProcessSpec),
    ],
  );
  const report = await port.run(preToolInput, signal);
  assert.equal(report.outcome.effect, 'none');
  assert.equal(report.failures.length, 2);
  assert.match(report.failures[0] ?? '', /exit 1（boom）/);
  assert.match(report.failures[1] ?? '', /超时/);
});

test('a deny stops the handler chain: the second handler never spawns', async () => {
  const process = new ScriptedProcess([
    resultOf({} as ProcessSpec, { exitCode: 2, stderr: 'first says no' }),
    resultOf({} as ProcessSpec),
  ]);
  const port = makePortWith(
    process,
    oneCommand({ PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] }),
  );
  const report = await port.run(preToolInput, signal);
  assert.equal(report.outcome.effect, 'deny');
  assert.equal(process.specs.length, 1, '先 deny 者胜（ADR-123 ②）');
});

test('UserPromptSubmit additionalContext becomes context; observation events ignore it', async () => {
  const port = makePort(
    oneCommand({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'ctx' }] }] }),
    [resultOf({} as ProcessSpec, { stdout: JSON.stringify({ additionalContext: 'remember: no deploys on friday' }) })],
  );
  const report = await port.run({ event: 'user-prompt-submit', sessionId: 's', cwd: '/repo', prompt: 'ship it' }, signal);
  assert.deepEqual(report.outcome, { effect: 'context', text: 'remember: no deploys on friday' });

  const stopPort = makePort(
    oneCommand({ Stop: [{ hooks: [{ type: 'command', command: 'ctx' }] }] }),
    [resultOf({} as ProcessSpec, { stdout: JSON.stringify({ additionalContext: 'ignored' }) })],
  );
  const stopped = await stopPort.run({ event: 'stop', sessionId: 's', cwd: '/repo' }, signal);
  assert.equal(stopped.outcome.effect, 'none', 'v1 观察型事件不注入（ADR-122 ①）');
});

test('PostToolUse updatedToolOutput rewrites and rewrites are last-wins', async () => {
  const port = makePort(
    oneCommand({
      PostToolUse: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
    }),
    [
      resultOf({} as ProcessSpec, { stdout: JSON.stringify({ hookSpecificOutput: { decision: 'block', reason: 'lint failed', updatedToolOutput: 'first rewrite' } }) }),
      resultOf({} as ProcessSpec, { stdout: JSON.stringify({ hookSpecificOutput: { updatedToolOutput: 'second rewrite' } }) }),
    ],
  );
  const report = await port.run({ event: 'post-tool-use', sessionId: 's', cwd: '/repo', toolName: 'Bash' }, signal);
  assert.deepEqual(report.outcome, { effect: 'rewrite', output: 'second rewrite', note: null });
});

test('unparseable JSON-looking stdout is a failure, plain text stdout is not', async () => {
  const bad = makePort(
    oneCommand({ PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] }),
    [resultOf({} as ProcessSpec, { stdout: '{ not json' })],
  );
  const badReport = await bad.run(preToolInput, signal);
  assert.equal(badReport.outcome.effect, 'none');
  assert.equal(badReport.failures.length, 1);

  const chatty = makePort(
    oneCommand({ PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] }),
    [resultOf({} as ProcessSpec, { stdout: 'just logging\n' })],
  );
  const fine = await chatty.run(preToolInput, signal);
  assert.equal(fine.outcome.effect, 'none');
  assert.equal(fine.failures.length, 0);
});

// ---------------------------------------------------------------------------
// Source files

test('loadHookSources: user files always load, project files need trust, order is user → project', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-hooks-home-'));
  const project = mkdtempSync(join(tmpdir(), 'cowcat-hooks-proj-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'user-a' }] }] } }));
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'proj-a' }] }] } }));
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'proj-b' }] }] } }));
  writeFileSync(join(project, 'cowcat.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'proj-c' }] }] } }));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const untrusted = await loadHookSources({ home, cowcatDir: join(home, '.cowcat'), projectRoot: project, trusted: false });
  assert.equal(untrusted.parsed.hooks.length, 1, '只有 user 层');
  assert.equal(untrusted.skippedUntrusted, 3);
  assert.equal(untrusted.loaded, 1);

  const trusted = await loadHookSources({ home, cowcatDir: join(home, '.cowcat'), projectRoot: project, trusted: true });
  assert.equal(trusted.parsed.hooks.length, 4);
  assert.equal(trusted.skippedUntrusted, 0);
  assert.equal(trusted.loaded, 4);
  assert.deepEqual(trusted.parsed.hooks.map((hook) => hook.command), ['user-a', 'proj-a', 'proj-b', 'proj-c']);

  const noProject = await loadHookSources({ home, cowcatDir: join(home, '.cowcat'), projectRoot: null, trusted: true });
  assert.equal(noProject.parsed.hooks.length, 1);
  assert.equal(noProject.skippedUntrusted, 0, '不在项目里就没有 project 文件可数');
});

test('loadHookSources: an unparseable settings file is an inert line, not a refusal', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-hooks-bad-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{ nope');
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const loaded = await loadHookSources({ home, cowcatDir: join(home, '.cowcat'), projectRoot: null, trusted: true });
  assert.equal(loaded.parsed.hooks.length, 0);
  assert.match(loaded.parsed.inert.join(''), /不是合法 JSON/);
});
