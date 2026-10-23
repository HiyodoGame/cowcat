import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASH_BACKGROUND_DEFAULT_TIMEOUT_MS,
  BASH_BACKGROUND_MAX_TIMEOUT_MS,
  BASH_DEFAULT_OUTPUT_CAP,
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  BASH_MIN_TIMEOUT_MS,
  NodeProcess,
  SandboxRequestRefusedError,
  createBashTool,
  defaultSandboxProfile,
  nodePlatform,
  type BackgroundStart,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTasksPort,
  type OutputSink,
  type PlatformPort,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
  type ToolGrant,
} from '../src/index.js';

const signal = new AbortController().signal;
const approved: ToolGrant = { networkApproved: true, unsandboxedApproved: false };
const notApproved: ToolGrant = { networkApproved: false, unsandboxedApproved: false };

const shell = { kind: 'posix' as const, executable: '/bin/sh', baseArgs: [] as readonly string[], commandFlag: '-c' };
const platform: PlatformPort = {
  platform: 'linux',
  resolveShell: () => shell,
  termination: () => ({ kind: 'process-group', graceMs: 100, supportsGraceful: true }),
  sandboxBackends: () => [],
};

function resultOf(spec: ProcessSpec, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    dropped: { stdout: 0, stderr: 0 },
    removedEnv: [],
    ignoredDeny: [],
    sandbox: { mode: spec.sandbox.mode, backend: spec.sandbox.mode === 'off' ? null : 'none', limitations: [] },
    termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    ...overrides,
  };
}

class FakeProcess implements ProcessPort {
  readonly specs: ProcessSpec[] = [];
  readonly sinks: (OutputSink | undefined)[] = [];
  constructor(private readonly overrides: Partial<ProcessResult> = {}, private readonly failure?: Error) {}

  run(spec: ProcessSpec, _signal?: AbortSignal, sink?: OutputSink): Promise<ProcessResult> {
    this.specs.push(spec);
    this.sinks.push(sink);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(resultOf(spec, this.overrides));
  }

  open(): Promise<never> {
    return Promise.reject(new Error('FakeProcess.open() is not used in this test'));
  }
}

class FakeBackground implements BackgroundTasksPort {
  readonly starts: BackgroundStart[] = [];
  constructor(private readonly failure?: Error) {}

  async start(spec: BackgroundStart): Promise<BackgroundTask> {
    if (this.failure !== undefined) throw this.failure;
    this.starts.push(spec);
    return { taskId: `bg_${String(this.starts.length)}` };
  }

  async stop(): Promise<boolean> {
    return false;
  }

  list(): readonly BackgroundTaskInfo[] {
    return [];
  }

  onExit(): () => void {
    return () => undefined;
  }

  async stopAll(): Promise<void> {
    // Nothing is running in this double.
  }
}

const tool = (
  process: ProcessPort,
  sandbox = defaultSandboxProfile(),
  env: Readonly<Record<string, string>> = { PATH: '/usr/bin' },
  background?: BackgroundTasksPort,
) =>
  createBashTool({
    cwd: '/repo',
    process,
    platform,
    sandbox,
    env,
    ...(background === undefined ? {} : { background }),
  });

test('the command is one argument to the resolved shell, not a shell string', async () => {
  const process = new FakeProcess();
  await tool(process).run({ command: 'echo hi && ls' }, signal, notApproved);

  const [spec] = process.specs;
  assert.ok(spec !== undefined);
  assert.deepEqual(spec.argv, ['/bin/sh', '-c', 'echo hi && ls']);
  assert.equal(spec.cwd, '/repo');
  assert.deepEqual(spec.env, { PATH: '/usr/bin' });
  assert.equal(spec.outputCap, BASH_DEFAULT_OUTPUT_CAP);
});

test('a live listener is forwarded to the process sink, and absent when nobody listens (ADR-108)', async () => {
  const process = new FakeProcess();
  const seen: string[] = [];
  await tool(process).run({ command: 'build' }, signal, notApproved, {
    sessionId: 'sess_test',
    callId: 'call_1',
    onOutput: (stream, text) => {
      seen.push(`${stream}:${text}`);
    },
  });

  const sink = process.sinks[0];
  assert.ok(sink !== undefined, 'the tool must not swallow the listener');
  sink.onOutput('stdout', 'ok\n');
  assert.deepEqual(seen, ['stdout:ok\n'], 'one vocabulary: the tool listener is the port sink');

  const quiet = new FakeProcess();
  await tool(quiet).run({ command: 'build' }, signal, notApproved);
  assert.equal(quiet.sinks[0], undefined, 'no listener, no sink — nothing is fabricated downstream');
});

test('run_in_background hands the command to the registry and does not wait for it (ADR-111)', async () => {
  const process = new FakeProcess();
  const background = new FakeBackground();
  const result = await tool(process, defaultSandboxProfile(), { PATH: '/usr/bin' }, background).run(
    { command: 'pnpm dev', run_in_background: true },
    signal,
    notApproved,
    { sessionId: 'sess_1', callId: 'call_9' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.background, { taskId: 'bg_1', command: 'pnpm dev' });
  assert.equal(process.specs.length, 0, 'the foreground gateway is not called at all');

  const start = background.starts[0];
  assert.ok(start !== undefined);
  assert.equal(start.sessionId, 'sess_1');
  assert.equal(start.callId, 'call_9');
  assert.equal(start.timeoutMs, BASH_BACKGROUND_DEFAULT_TIMEOUT_MS);
  assert.deepEqual(start.argv, ['/bin/sh', '-c', 'pnpm dev']);
});

test('background timeouts default to 30 minutes and cap at two hours (ADR-112)', async () => {
  const background = new FakeBackground();
  const runner = tool(new FakeProcess(), defaultSandboxProfile(), { PATH: '/usr/bin' }, background);
  const context = { sessionId: 's', callId: 'c' };

  await runner.run({ command: 'a', run_in_background: true }, signal, notApproved, context);
  await runner.run({ command: 'b', run_in_background: true, timeout: 10 }, signal, notApproved, context);
  await runner.run({ command: 'c', run_in_background: true, timeout: 100_000_000 }, signal, notApproved, context);

  assert.deepEqual(
    background.starts.map((start) => start.timeoutMs),
    [BASH_BACKGROUND_DEFAULT_TIMEOUT_MS, BASH_MIN_TIMEOUT_MS, BASH_BACKGROUND_MAX_TIMEOUT_MS],
  );
});

test('run_in_background is refused when the host has no registry, instead of silently running in front', async () => {
  const process = new FakeProcess();
  const result = await tool(process).run({ command: 'x', run_in_background: true }, signal, notApproved);

  assert.equal(result.ok, false);
  assert.match(result.output, /not available in this build/u);
  assert.equal(process.specs.length, 0);
});

test('a background start that fails is reported, not claimed as running', async () => {
  const result = await tool(
    new FakeProcess(),
    defaultSandboxProfile(),
    { PATH: '/usr/bin' },
    new FakeBackground(new Error('spawn failed')),
  ).run({ command: 'x', run_in_background: true }, signal, notApproved, { sessionId: 's', callId: 'c1' });

  assert.equal(result.ok, false);
  assert.match(result.output, /failed to start background command: spawn failed/u);
  assert.equal(result.background, undefined);
});

test('the timeout defaults, clamps low, and caps high', async () => {
  const process = new FakeProcess();
  const runner = tool(process);

  await runner.run({ command: 'a' }, signal, notApproved);
  await runner.run({ command: 'b', timeout: 10 }, signal, notApproved);
  await runner.run({ command: 'c', timeout: 10_000_000 }, signal, notApproved);

  assert.deepEqual(process.specs.map((spec) => spec.timeoutMs), [BASH_DEFAULT_TIMEOUT_MS, BASH_MIN_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS]);
});

test('stdout, stderr and a non-zero exit are reported, and a non-zero exit is not a failure', async () => {
  const process = new FakeProcess({ stdout: 'built ok\n', stderr: 'warning: deprecated\n', exitCode: 2 });
  const result = await tool(process).run({ command: 'npm test' }, signal, notApproved);

  assert.equal(result.ok, true);
  assert.equal(result.output, 'built ok\nstderr: warning: deprecated\nexit code: 2');
});

test('a timeout is a failure of the call, and says the command was still running', async () => {
  const process = new FakeProcess({
    termination: { requested: true, reason: 'timeout', strategy: 'process-group', escalated: true, fallbackUsed: false, residuePossible: false },
  });
  const result = await tool(process).run({ command: 'sleep 100', timeout: 5_000 }, signal, notApproved);

  assert.equal(result.ok, false);
  assert.match(result.output, /\[terminated: timeout after 5000ms — the command was still running\]/);
});

test('truncation comes back as a structured fact with the cap that caused it', async () => {
  const process = new FakeProcess({ stdout: 'tail', truncated: true, dropped: { stdout: 12_000, stderr: 30 } });
  const result = await tool(process).run({ command: 'cat big' }, signal, notApproved);

  assert.deepEqual(result.truncation, {
    truncated: true,
    dropped: 12_030,
    reason: `bash: output cap (${String(BASH_DEFAULT_OUTPUT_CAP)} characters per stream)`,
  });
  assert.match(result.output, /\[output truncated at 100000 characters per stream: 12000 stdout \+ 30 stderr dropped\]/);
});

test('the gateway facts are passed through, so the audit can see what actually ran', async () => {
  const process = new FakeProcess({ removedEnv: ['AWS_SECRET_ACCESS_KEY'], ignoredDeny: ['/bad regex/'] });
  const result = await tool(process, defaultSandboxProfile({ mode: 'system' })).run({ command: 'ls' }, signal, notApproved);

  assert.deepEqual(result.facts, {
    sandbox: { mode: 'system', backend: 'none', limitations: [] },
    termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    removedEnv: ['AWS_SECRET_ACCESS_KEY'],
    ignoredDeny: ['/bad regex/'],
  });
  assert.match(result.output, /\[sandboxed: none\]/);
});

test('light mode does not print a line that reads like OS-level isolation', async () => {
  const process = new FakeProcess({ stdout: 'ok' });
  const result = await tool(process, defaultSandboxProfile({ mode: 'light' })).run({ command: 'ls' }, signal, notApproved);

  assert.equal(result.output.includes('sandboxed'), false);
});

test('network off and on are passed through untouched', async () => {
  const process = new FakeProcess();
  await tool(process, defaultSandboxProfile({ network: 'off' })).run({ command: 'a' }, signal, approved);
  await tool(process, defaultSandboxProfile({ network: 'on' })).run({ command: 'b' }, signal, notApproved);

  assert.deepEqual(process.specs.map((spec) => spec.sandbox.network), ['off', 'on']);
});

test('network "ask" becomes "on" only for an approved call', async () => {
  const process = new FakeProcess();
  const runner = tool(process, defaultSandboxProfile({ network: 'ask' }));

  const result = await runner.run({ command: 'curl example.com' }, signal, approved);

  assert.equal(result.ok, true);
  assert.equal(process.specs[0]?.sandbox.network, 'on');
});

test('network "ask" without a grant is refused, never silently downgraded to off', async () => {
  const process = new FakeProcess();
  const result = await tool(process, defaultSandboxProfile({ network: 'ask' })).run({ command: 'curl example.com' }, signal, notApproved);

  assert.equal(result.ok, false);
  assert.equal(process.specs.length, 0, 'nothing may be started');
  assert.match(result.output, /network: "ask"/);
  assert.match(result.output, /silently switched off would be a downgrade/);
});

test('run_in_background is refused by name instead of ignored', async () => {
  const process = new FakeProcess();
  const result = await tool(process).run({ command: 'npm run dev', run_in_background: true }, signal, notApproved);

  assert.equal(result.ok, false);
  assert.equal(process.specs.length, 0);
  assert.match(result.output, /not available in this build/);
});

test('a gateway refusal (a sandbox that cannot run here) is a result, not a throw', async () => {
  const process = new FakeProcess({}, new Error('sandbox "system" is not available here [missing]: bwrap is not installed'));
  const result = await tool(process, defaultSandboxProfile({ mode: 'system' })).run({ command: 'ls' }, signal, notApproved);

  assert.equal(result.ok, false);
  assert.match(result.output, /failed to start command: sandbox "system" is not available here/);
});

test('the tool narrows on the command, so command-prefix rules can match', () => {
  const spec = tool(new FakeProcess()).spec;

  assert.equal(spec.commandInput, 'command');
  assert.equal(spec.risk, 'exec');
  assert.deepEqual((spec.inputSchema as Record<string, unknown>).required, ['command']);
});

// Real processes, through the real gateway: the argv shape above is asserted against a
// double, and these cases are what proves the shell actually runs what we hand it. They
// pass no `env`, so the child inherits this process's environment — a fabricated PATH
// is enough to stop a real shell from starting on Windows.
function realTool(): ReturnType<typeof createBashTool> {
  const realPlatform = nodePlatform();
  return createBashTool({
    cwd: process.cwd(),
    process: new NodeProcess({ platform: realPlatform }),
    platform: realPlatform,
    sandbox: defaultSandboxProfile({ mode: 'off' }),
  });
}

test('a real command runs through NodeProcess and comes back with facts', async () => {
  const result = await realTool().run({ command: 'echo cowcat-bash-ok' }, signal, notApproved);

  assert.equal(result.ok, true);
  assert.match(result.output, /cowcat-bash-ok/);
  const facts = result.facts;
  assert.ok(facts !== undefined, 'the gateway facts must reach the tool result');
  assert.equal(facts.sandbox.mode, 'off');
  assert.deepEqual(facts.removedEnv, []);
});

test('a real non-zero exit is reported with its code and is still not a failure', async () => {
  const result = await realTool().run({ command: 'exit 3' }, signal, notApproved);

  assert.equal(result.ok, true);
  assert.match(result.output, /exit code: 3/);
});

test('an oversized result spills to the session directory as a reference plus head (ADR-119)', async (t) => {
  const spillRoot = mkdtempSync(join(tmpdir(), 'cowcat-spill-bash-'));
  t.after(() => {
    rmSync(spillRoot, { recursive: true, force: true });
  });
  const process = new FakeProcess({ stdout: 'x'.repeat(60_000) });
  const runner = createBashTool({
    cwd: '/repo',
    process,
    platform,
    sandbox: defaultSandboxProfile({ mode: 'off' }),
    spill: { rootDir: spillRoot },
  });

  const result = await runner.run({ command: 'big' }, signal, notApproved, {
    sessionId: 'sess_bash',
    callId: 'call_big',
  });

  assert.equal(result.ok, true);
  assert.match(result.output, /^\[spilled: full output of \d+ bytes written to /);
  assert.ok(result.output.includes('first 4096 bytes below'));
  // The spilled file holds what render produced; the inline output is reference + head.
  const spilled = readFileSync(join(spillRoot, 'sess_bash', 'spill', 'call_big.txt'), 'utf8');
  assert.equal(spilled, 'x'.repeat(60_000));
});

test('a bash call without a run context travels whole even when oversized', async () => {
  const process = new FakeProcess({ stdout: 'x'.repeat(60_000) });
  const runner = tool(process);

  const result = await runner.run({ command: 'big' }, signal, notApproved);

  assert.equal(result.ok, true);
  assert.equal(result.output, 'x'.repeat(60_000));
});

test('a sandbox refusal names itself and points at the appeal, and marks the result', async () => {
  const refusing = new FakeProcess({}, new SandboxRequestRefusedError('network: on', 'test refusal', 'profile forbids the network', ['run without the network']));
  const result = await tool(refusing).run({ command: 'npm install' }, signal, notApproved);

  assert.equal(result.ok, false);
  assert.equal(result.sandboxRefused, true, 'the kernel only offers a waiver after a real refusal');
  assert.match(result.output, /sandbox refused: sandbox "system" cannot satisfy network: on/);
  assert.match(result.output, /Escalate/);
  assert.doesNotMatch(result.output, /failed to start command/, 'a refusal must not masquerade as a start failure');
});

test('an approved waiver runs this once without the sandbox', async () => {
  const process = new FakeProcess();
  const waived: ToolGrant = { networkApproved: false, unsandboxedApproved: true };
  const result = await tool(process).run({ command: 'npm install' }, signal, waived);

  assert.equal(result.ok, true);
  const [spec] = process.specs;
  assert.ok(spec !== undefined);
  assert.equal(spec.sandbox.mode, 'off');
  assert.equal(spec.sandbox.backend, 'none');
});

test('no waiver, no change: the profile passes through untouched', async () => {
  const process = new FakeProcess();
  await tool(process).run({ command: 'npm install' }, signal, notApproved);

  const [spec] = process.specs;
  assert.ok(spec !== undefined);
  assert.equal(spec.sandbox.mode, defaultSandboxProfile().mode);
});