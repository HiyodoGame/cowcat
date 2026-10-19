import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, createServer, memoryTransport } from '@corescense/cowcat-protocol';
import {
  createHost,
  type ModelChunk,
  type ModelPort,
  type PlatformPort,
  type ProcessPort,
  type ProcessResult,
  type ProcessSpec,
} from '@corescense/cowcat-core';
import { frameOf, initialView, project, type TuiView } from '@corescense/cowcat-tui';

/**
 * P6's first exit criterion, in the only form that actually tests it:
 *
 *   > 用 headless 协议完整跑通一个带工具与审批的回合（测试中）
 *
 * Every piece of that already had a suite of its own — the kernel's turn loop, the host's
 * protocol implementation, the frontend's `project()`. What none of them had is the SEAM: the
 * event stream the server really emits, fed through the frontend's own pure functions, and a
 * screen that shows the tool card and the approval card a user would have seen.
 *
 * It lives in `packages/cli` because that is the only package allowed to see both halves
 * (ADR-062 ③). It touches no renderer: `project()` and `frameOf()` produce `Line[]`, which is
 * the point of ADR-066 ③ — so this test runs on the CLI's Node 22 leg, not only on 26.
 */

const SHELL: PlatformPort = {
  platform: 'linux',
  resolveShell: () => ({ kind: 'posix', executable: '/bin/sh', baseArgs: ['-c'], commandFlag: '-c' }),
  termination: () => ({ kind: 'process-group', graceMs: 0, supportsGraceful: true }),
  sandboxBackends: () => [],
};

const PROCESS: ProcessPort = {
  run: (spec: ProcessSpec): Promise<ProcessResult> =>
    Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      dropped: { stdout: 0, stderr: 0 },
      removedEnv: [],
      ignoredDeny: [],
      sandbox: { mode: spec.sandbox.mode, backend: null, limitations: [] },
      termination: { requested: false, reason: 'none', strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false },
    }),
};

/** Two model calls: ask to write a file, then answer. No network, no key. */
class ScriptedModel implements ModelPort {
  #calls = 0;
  readonly #script: readonly (readonly ModelChunk[])[];

  constructor(script: readonly (readonly ModelChunk[])[]) {
    this.#script = script;
  }

  async *stream(): AsyncIterable<ModelChunk> {
    const step = this.#script[this.#calls] ?? [];
    this.#calls += 1;
    for (const chunk of step) yield chunk;
  }
}

function isolatedHome(t: { after(fn: () => void): void }): { readonly home: string; readonly cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-exit-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-exit-cwd-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  mkdirSync(join(home, '.cowcat'), { recursive: true });
  writeFileSync(
    join(home, '.cowcat', 'config.json'),
    `${JSON.stringify({ model: { preset: 'anthropic/claude-sonnet-5-5' } })}\n`,
  );
  return { home, cwd };
}

test('a turn with a tool and an approval, over the protocol, as the frontend renders it', async (t) => {
  const { home, cwd } = isolatedHome(t);

  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-exit',
    platform: SHELL,
    process: PROCESS,
    model: new ScriptedModel([
      [
        {
          type: 'tool_call',
          call: { callId: 'call_1', name: 'Write', input: { file_path: join(cwd, 'out.txt'), content: 'hi\n' } },
        },
      ],
      [{ type: 'text', text: '写好了。' }],
    ]),
  });

  const pair = memoryTransport();
  const server = createServer({ host, transport: pair.server });
  const client = createClient({ transport: pair.client });

  let view: TuiView = initialView();
  const events: string[] = [];
  client.on('event', (event) => {
    events.push(event.type);
    view = project(view, event);
  });

  const frame = (): string => frameOf(view, { width: 60, now: 0 }).body.map((row) => row.text).join('\n');

  try {
    await client.initialize();
    const created = await client.createSession('sess_exit');
    assert.equal(created.lastSeq, 1);
    await client.openSession('sess_exit');
    await client.sendTurn('sess_exit', '写个文件');

    // 1. The tool call is asked about, and the protocol says which one.
    const asked = await waitFor(
      () => (view.approval !== null && view.approval.verdict === null ? view.approval : null),
      'the approval request',
    );
    assert.equal(asked.name, 'Write');
    assert.match(frame(), /╭─ ⚠ Write/);

    await client.respondApproval('sess_exit', asked.callId, 'once');

    // 2. The turn finishes, and the transcript carries the whole story.
    await waitFor(() => view.turn?.state === 'completed', 'the turn to complete');
    const text = frame();
    assert.match(text, /╭─ 你/, 'the user spoke');
    assert.match(text, /写个文件/);
    assert.match(text, /⏺ Write ok/, 'the tool card');
    assert.match(text, /写好了。/, 'the answer');
    // The question is gone once its turn is over: the card is the PENDING question, and the
    // record of the answer is the log (`approval.answered`) plus the tool card that ran.
    assert.doesNotMatch(text, /╭─ ⚠ Write/, 'no question is left hanging after the turn');

    // 3. Every fact came from the protocol, in order: the approval is asked before it is
    //    answered, and the tool finished before the answer.
    const askedAt = events.indexOf('approval.requested');
    const answeredAt = events.indexOf('approval.answered');
    const finishedAt = events.indexOf('tool.finished');
    assert.ok(askedAt >= 0 && answeredAt > askedAt, `asked before answered: ${events.join(', ')}`);
    assert.ok(finishedAt > answeredAt, 'the tool ran after the approval');
  } finally {
    client.close();
    await server.closed;
    await host.close();
  }
});

/** Poll the view, because the protocol delivers on microtasks. */
async function waitFor<T>(check: () => T | null | false, what: string): Promise<T> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const value = check();
    if (value !== null && value !== false) return value;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}
