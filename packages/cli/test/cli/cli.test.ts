import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { parseResponse } from '@corescense/cowcat-protocol';
import { COMMANDS, EXIT, runCli } from '../../src/index.js';

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function cli(argv: readonly string[], options: Parameters<typeof runCli>[1] = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => out.push(line),
    write: (text) => out.push(text),
    stderr: (line) => err.push(line),
    ...options,
  });
  return { code, out, err };
}

/**
 * Our state directory, moved to a temp dir for the duration of a test.
 *
 * `COWCAT_HOME` exists for this reason as much as any other: a test that created sessions
 * in the developer's real `~/.cowcat` would be a test nobody dares run twice.
 */
function isolatedHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-cli-home-'));
  const previous = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('--help lists every command in the table', async () => {
  const run = await cli(['--help']);
  assert.equal(run.code, EXIT.ok);
  const text = run.out.join('\n');
  for (const command of COMMANDS) {
    assert.ok(text.includes(command.usage), `${command.name} is missing from the help text`);
  }
  // The options come from the same declaration the parser uses.
  assert.match(text, /--config <path>/);
  assert.match(text, /--yes/);
  assert.match(text, /--migrate/);
  assert.match(text, /COWCAT_HOME/);
});

test('-h and --version behave, and the version is a real version', async () => {
  const short = await cli(['-h']);
  assert.equal(short.code, EXIT.ok);
  assert.ok(short.out.join('\n').includes('cowcat'));

  const run = await cli(['--version']);
  assert.equal(run.code, EXIT.ok);
  assert.match(run.out.join('\n').trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown verb is a usage error, and says what exists', async () => {
  const run = await cli(['pause']);
  assert.equal(run.code, EXIT.usage);
  const err = run.err.join('\n');
  assert.match(err, /未知命令 "pause"/);
  assert.match(err, /serve/);
  assert.match(err, /--help/);
});

test('missing or extra arguments are usage errors, checked before anything runs', async () => {
  const noPrompt = await cli(['run']);
  assert.equal(noPrompt.code, EXIT.usage);
  assert.match(noPrompt.err.join('\n'), /用法：cowcat run "<prompt>"/);

  const noId = await cli(['sessions', 'resume']);
  assert.equal(noId.code, EXIT.usage);

  const extra = await cli(['sessions', 'list', 'extra']);
  assert.equal(extra.code, EXIT.usage);
});

test('options are validated against the table, and a bad one is a usage error', async (t) => {
  isolatedHome(t);
  // Checked BEFORE the handler, so nothing was built and no file was touched.
  const unknown = await cli(['run', '--nope', 'hello']);
  assert.equal(unknown.code, EXIT.usage);
  assert.match(unknown.err.join('\n'), /不认识的选项：--nope/);

  const missingValue = await cli(['run', '--config']);
  assert.equal(missingValue.code, EXIT.usage);
  assert.match(missingValue.err.join('\n'), /--config 需要一个值/);

  // `--config --yes`: the value looks like another option, which is almost always a
  // forgotten path rather than a file named `--yes`.
  const swallowed = await cli(['run', '--config', '--yes', 'hello']);
  assert.equal(swallowed.code, EXIT.usage);
  assert.match(swallowed.err.join('\n'), /--config 需要一个值/);

  // `--` ends option parsing, so a prompt that starts with a dash survives. Without the
  // terminator this would be an unknown OPTION (a usage error), which is what makes the
  // two exits distinguishable.
  const literal = await cli(['run', '--', '--help']);
  assert.equal(literal.code, EXIT.failed, 'the prompt ran; it failed for the missing model, not the syntax');
  assert.match(literal.err.join('\n'), /no model is configured|未配置/);
  assert.doesNotMatch(literal.err.join('\n'), /不认识的选项/);
});

// The TUI's floor (ADR-056/ADR-065 ①): the `tui` verb and `sessions resume` are the two
// that load a renderer, and on an older Node they must refuse with a sentence instead of
// dying inside a native module. On a recent Node those two verbs would start a real
// terminal interface, which an in-process test cannot host — so they are skipped there
// rather than hanging the suite.
const [NODE_MAJOR = 0, NODE_MINOR = 0] = process.versions.node.split('.').map(Number);
const RENDERER_AVAILABLE = NODE_MAJOR > 26 || (NODE_MAJOR === 26 && NODE_MINOR >= 4);
const SKIP_ON_RENDERER = RENDERER_AVAILABLE ? 'this build would start a real TUI here' : false;

test('no arguments means the default verb, and on an old Node it says why', { skip: SKIP_ON_RENDERER }, async () => {
  const run = await cli([]);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /cowcat tui: 需要 Node >=26\.4/);
  assert.match(run.err.join('\n'), /Node 22 上就能用/);
});

test('setup without a mode explains the two ways to use it', async (t) => {
  isolatedHome(t);
  const run = await cli(['setup']);
  assert.equal(run.code, EXIT.usage);
  assert.match(run.err.join('\n'), /--migrate/);
  assert.match(run.err.join('\n'), /--preset/);
});

test('sessions resume is the TUI with an id, and checks the renderer floor first', { skip: SKIP_ON_RENDERER }, async () => {
  const run = await cli(['sessions', 'resume', 'sess_anything']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /cowcat tui: 需要 Node >=26\.4/);
});

test('sessions list reads the store directly, and says so when there is nothing', async (t) => {
  const home = isolatedHome(t);
  const empty = await cli(['sessions', 'list']);
  assert.equal(empty.code, EXIT.ok);
  assert.match(empty.out.join('\n'), /没有会话/);
  // The path it looked in is part of the answer: "nothing" is only useful with a WHERE.
  assert.match(empty.out.join('\n'), new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('a session on disk shows up in sessions list', async (t) => {
  const home = isolatedHome(t);
  // Written through the same store the host uses, so this is the real on-disk shape
  // rather than a hand-written line that would pass whatever the reader happens to do.
  const { JsonlEventStore, SCHEMA_VERSION } = await import('@corescense/cowcat-core');
  const store = new JsonlEventStore(join(home, 'sessions'));
  await store.append({
    type: 'session.opened',
    seq: 1,
    ts: 1,
    sessionId: 'sess_listed',
    turnId: null,
    schemaVersion: SCHEMA_VERSION,
    cowcatVersion: '0.0.0-test',
    shell: { kind: 'posix', executable: '/bin/sh' },
  });

  const run = await cli(['sessions', 'list']);
  assert.equal(run.code, EXIT.ok);
  assert.match(run.out.join('\n'), /sess_listed\t1 条事件/);
});

test('sessions list hides delegated children unless --all asks for them', async (t) => {
  const home = isolatedHome(t);
  const { JsonlEventStore, SCHEMA_VERSION } = await import('@corescense/cowcat-core');
  const store = new JsonlEventStore(join(home, 'sessions'));
  const header = (sessionId: string, parent?: { readonly sessionId: string; readonly role: 'explore' }) => ({
    type: 'session.opened' as const,
    seq: 1,
    ts: 1,
    sessionId,
    turnId: null,
    schemaVersion: SCHEMA_VERSION,
    cowcatVersion: '0.0.0-test',
    shell: { kind: 'posix' as const, executable: '/bin/sh' },
    ...(parent === undefined ? {} : { parent }),
  });
  await store.append(header('sess_top'));
  await store.append(header('sess_child', { sessionId: 'sess_top', role: 'explore' }));

  const plain = await cli(['sessions', 'list']);
  assert.equal(plain.code, EXIT.ok);
  assert.match(plain.out.join('\n'), /sess_top/);
  assert.doesNotMatch(plain.out.join('\n'), /sess_child/, 'a child is evidence of a delegation, not a session a person opens');

  const all = await cli(['sessions', 'list', '--all']);
  assert.equal(all.code, EXIT.ok);
  const text = all.out.join('\n');
  assert.match(text, /sess_child/);
  assert.match(text, /父会话 sess_top/);
});

test('doctor reports what it can check, and names the model it could not find', async (t) => {
  isolatedHome(t);
  const run = await cli(['doctor']);
  // Nothing here is a FAIL on a supported runtime: "no model configured" is a state
  // (ADR-064 ⑥) and the sandbox tier in effect needs no OS backend.
  assert.equal(run.code, EXIT.ok, run.out.join('\n'));
  const text = run.out.join('\n');
  assert.match(text, /node\s+v\d+\.\d+\.\d+（需要 >=22）/);
  assert.match(text, /protocol\s+version \d+/);
  // With no config file the defaults are in effect, and that is stated rather than
  // reported as a fault.
  assert.match(text, /配置\s+没有配置文件/);
  assert.match(text, /trust\s+.*未受信/);
  assert.match(text, /rules\s+\d+ 条/);
  // What the model would be told about this repository (ADR-075~078). The isolated home
  // has no trust entry while the chain still finds the repository's AGENTS.md, so the
  // honest answer is the skip, with the file named and the withheld line count given.
  // Both halves are pinned on purpose: accepting "no file" would also pass if the walk
  // stopped early, and accepting any `instr` row would pass if the trust gate regressed.
  assert.match(text, /instr\s+folder not trusted: skipped AGENTS\.md \(\d+ lines\)/);
  assert.match(text, /sandbox\s+mode \w+ \/ backend \w+ \/ network \w+/);
  // Two different questions, two rows: the build runs here, and the TUI's floor is the
  // renderer's (ADR-065 ①).
  assert.match(text, /渲染器\s+(v26\.4 起可用|TUI 需要 >=26\.4)/);
  assert.match(text, /模型\s+未配置/);
});

interface ServeHarness {
  /** The temp state directory this `serve` was started with. */
  readonly home: string;
  readonly send: (id: number, method: string, params: object) => void;
  /** Waits for a reply, because building the real host is not instant. */
  readonly settle: (id: number) => Promise<string>;
  readonly done: Promise<number>;
  readonly protocolLines: readonly string[];
}

/**
 * `serve` over injected streams, with the reply captured by id.
 *
 * The wait is a wait, not a timing assertion: since T4a 3/3 the handler builds the real
 * host first (probes the shell, reads the config), so a handshake reply does not arrive in
 * the same event-loop turn any more.
 */
function serveHarness(t: TestContext): ServeHarness {
  const home = isolatedHome(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map<number, string>();
  const protocolLines: string[] = [];
  const done = runCli(['serve'], {
    stdin: input,
    stdoutStream: output,
    stdout: () => undefined,
    stderr: () => undefined,
  });

  output.setEncoding('utf8');
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      protocolLines.push(line);
      const parsed = parseResponse(line);
      if (parsed !== null && typeof parsed.id === 'number') replies.set(parsed.id, line);
    }
  });

  return {
    home,
    done,
    protocolLines,
    send: (id, method, params) => {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    },
    settle: async (id) => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const line = replies.get(id);
        if (line !== undefined) return line;
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      throw new Error(`no reply to request ${String(id)} within 6s`);
    },
  };
}

test('serve is wired: the CLI drives the protocol over injected streams', async (t) => {
  const harness = serveHarness(t);

  harness.send(1, 'initialize', { protocolVersion: 1 });
  const reply = parseResponse(await harness.settle(1));
  assert.ok(reply !== null && 'result' in reply, `expected a handshake reply, got ${harness.protocolLines[0] ?? 'nothing'}`);

  harness.send(2, 'shutdown', {});
  await harness.settle(2);
  assert.equal(await harness.done, EXIT.ok);
});

test('serve is wired to the REAL host: a session is created on disk and a turn refuses without a model', async (t) => {
  const harness = serveHarness(t);
  const home = harness.home;

  harness.send(1, 'initialize', { protocolVersion: 1 });
  await harness.settle(1);

  harness.send(2, 'session.create', { sessionId: 'sess_cli' });
  const created = JSON.parse(await harness.settle(2)) as { result?: { sessionId?: string; lastSeq?: number } };
  assert.equal(created.result?.sessionId, 'sess_cli');
  assert.equal(created.result.lastSeq, 1, 'the header is the first line');

  // The log is really there, in the directory ADR-064 names.
  const dir = join(home, 'sessions');
  assert.deepEqual(readdirSync(dir).sort(), ['sess_cli.jsonl', 'sess_cli.jsonl.lock']);

  // No model is configured in this temp home, so the turn is refused with a code and a
  // named problem rather than a stack trace (ADR-064 ⑥).
  harness.send(3, 'turn.send', { sessionId: 'sess_cli', input: 'hello' });
  const refused = JSON.parse(await harness.settle(3)) as { error?: { code?: number; message?: string; data?: unknown } };
  assert.equal(refused.error?.code, -32004, 'hostRefused');
  assert.match(refused.error.message ?? '', /no model is configured/);
  assert.deepEqual(refused.error.data, { problem: 'not-configured' });

  harness.send(4, 'shutdown', {});
  await harness.settle(4);
  assert.equal(await harness.done, EXIT.ok);

  // Closing the host released the lock: a leftover lock file would make the next run
  // report "writer pid … is gone but left its lock file behind" (ADR-010).
  assert.deepEqual(readdirSync(dir), ['sess_cli.jsonl']);
});

test('run refuses a prompt when no model is configured, and stays exit 1', async (t) => {
  isolatedHome(t);
  const run = await cli(['run', 'hello']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /no model is configured|未配置/);
});

test('run --session on a session that does not exist says so instead of starting one', async (t) => {
  isolatedHome(t);
  const run = await cli(['run', '--session', 'sess_absent', 'hello']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err.join('\n'), /sess_absent/);
});

test('the table has no duplicated verbs, exactly one default, and no duplicated option', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(COMMANDS.filter((command) => command.isDefault === true).length, 1);
  for (const command of COMMANDS) {
    const flags = (command.flags ?? []).map((flag) => flag.name);
    assert.equal(new Set(flags).size, flags.length, `${command.name} declares an option twice`);
  }
});
