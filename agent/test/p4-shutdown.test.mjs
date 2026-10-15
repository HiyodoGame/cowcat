// P4: background registry shutdown correctness — killAll actually kills exec
// children (the -p hang), stop() works on async tasks (Agent run_in_background)
// with AbortSignal plumbed through, and snapshot() truncation keeps the tail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackgroundRegistry } from '../src/background.js';
import { AgentTool } from '../src/tools/agent.js';

test('killAll: exec child is killed and the task reports terminal state', async () => {
  const reg = new BackgroundRegistry();
  // sleeps far longer than any test budget; only a real kill ends it early
  const task = reg.start('node -e "setTimeout(()=>{},30000)"', { cwd: mkdtempSync(join(tmpdir(), 'cowcat-bg-')) });
  assert.equal(reg.snapshot(task).running, true, 'running before kill');

  reg.killAll();
  assert.equal(task.done, true);
  assert.equal(task.killed, true);
  assert.equal(reg.snapshot(task).running, false);
  assert.equal(reg.tasks.size, 0, 'killAll clears the registry');

  // the event loop must be free: if the child survived, the test process
  // itself would not exit (this is the -p hang, observed directly)
  await new Promise((r) => setTimeout(r, 300));
});

test('snapshot: long output keeps the TAIL, not the head', async () => {
  const reg = new BackgroundRegistry();
  const task = reg.startAsync(async () => `HEAD${'x'.repeat(30_000)}TAIL-MARKER`);
  await new Promise((r) => setTimeout(r, 50)); // let the promise settle

  const { output } = reg.snapshot(task);
  assert.ok(output.includes('TAIL-MARKER'), 'the end of the log survives');
  assert.ok(!output.includes('HEAD'), 'the beginning is what gets dropped');
  assert.match(output, /earlier output dropped, showing last 20000/);
  assert.ok(output.length < 21_000);
});

test('stop: async task aborts its signal and reports killed — no TypeError', async () => {
  const reg = new BackgroundRegistry();
  let sawSignal = null;
  let release;
  const gate = new Promise((r) => { release = r; });
  const task = reg.startAsync(async (signal) => {
    sawSignal = signal;
    await gate; // still in flight when stop() lands
    return 'never observed';
  });
  await new Promise((r) => setTimeout(r, 10)); // let fn start and capture the signal
  assert.ok(sawSignal instanceof AbortSignal, 'the function receives the AbortSignal');
  assert.equal(sawSignal.aborted, false);

  const stopped = reg.stop(task.id);
  assert.ok(stopped, 'stop returns the task');
  assert.equal(stopped.done, true);
  assert.equal(stopped.killed, true);
  assert.equal(stopped.exitCode, 137, 'in-flight killed tasks report 137');
  assert.equal(sawSignal.aborted, true, 'the signal is aborted');
  assert.equal(reg.get(task.id), undefined, 'non-silent stop removes the record');

  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(task.stdout, '', 'the post-kill result is discarded');
});

test('stop: a late-resolving async task cannot un-kill itself', async () => {
  const reg = new BackgroundRegistry();
  let release;
  const gate = new Promise((r) => { release = r; });
  const task = reg.startAsync(async (signal) => {
    await gate; // still in flight when stop() lands
    if (signal.aborted) return 'should-be-ignored';
    return 'clean-result';
  });

  reg.stop(task.id, { silent: true }); // silent so the record survives for inspection
  release();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(task.killed, true);
  assert.equal(task.exitCode, null, 'silent stop leaves exitCode null');
  assert.equal(task.stdout, '', 'the cancelled result is discarded');
  assert.equal(reg.snapshot(task).running, false);
});

test('Agent run_in_background: TaskStop signal reaches spawnAgent', async () => {
  const seen = [];
  const fakeRegistry = {
    startAsync(fn, opts) {
      const rec = { id: 'task_fake', opts, fn };
      seen.push(rec);
      // simulate what the real registry does: hand the signal to fn
      const ac = new AbortController();
      rec.ac = ac;
      rec.abort = () => ac.abort();
      void fn(ac.signal); // the tool must tolerate a fast-resolving fn
      return rec;
    },
  };
  const ctx = {
    spawnAgent: async ({ description, prompt, signal }) => {
      seen.push({ description, prompt, signal });
      return 'sub-agent-report';
    },
    background: fakeRegistry,
  };

  const res = await AgentTool.execute({ description: 'probe', prompt: 'look around', run_in_background: true }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /task_fake/);

  const spawnCall = seen.find((s) => s.prompt === 'look around');
  assert.ok(spawnCall, 'spawnAgent was invoked with the signal');
  assert.ok(spawnCall.signal instanceof AbortSignal, 'the spawn receives an AbortSignal');
  assert.equal(spawnCall.description, 'probe');
});
