import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { noTermination, terminateTree, type TreeKiller } from '../src/index.js';
import { fakePlatform } from './fakes-ports.js';
import { posixTermination, windowsTermination } from './fakes-ports.js';

// The termination protocol, with fakes.
//
// The bugs that matter here are arithmetic and branch selection: escalate or not,
// fall back or not, report an escalation that never happened. None of that needs a
// real process, and testing it with real processes would test the OS instead. The
// real-child tests live in process.test.ts.
//
// Every rule under test is a measured boundary from research/p2-ports.md appendix B:
// taskkill /T must run while the child is alive (exit 128 means the tree is
// unreachable, descendants survive), and a setsid() descendant leaves the POSIX
// process group.

interface Script {
  readonly signalled: ('SIGTERM' | 'SIGKILL')[];
  readonly taskkillCalls: number[];
  readonly childKills: number[];
}

function killer(options: {
  /** false = the group could not be signalled (EPERM), which is the fallback case. */
  readonly signalWorks?: boolean;
  readonly taskkillCode?: number | null;
  readonly taskkillError?: string | null;
}): { killer: TreeKiller; script: Script } {
  const script: Script = { signalled: [], taskkillCalls: [], childKills: [] };
  return {
    script,
    killer: {
      signalGroup: (_pid, signal) => {
        script.signalled.push(signal);
        return options.signalWorks ?? true;
      },
      taskkillTree: (pid) => {
        script.taskkillCalls.push(pid);
        // `in` rather than `??`: taskkillCode: null is a real case (it could not be
        // started) and `null ?? 0` would quietly turn it into success.
        const code = 'taskkillCode' in options ? options.taskkillCode : 0;
        return { code, error: options.taskkillError ?? null };
      },
      killChild: () => {
        script.childKills.push(1);
        return true;
      },
    },
  };
}

/**
 * Only `pid` is read by the protocol. No default: a default would silently turn
 * `child(undefined)` — the "never got a pid" case — into a real pid.
 */
function child(pid: number | undefined): ChildProcess {
  return { pid } as ChildProcess;
}

/** waitForExit that answers from a script rather than from the clock. */
function exitsWithin(script: { exitedAfterFirstWait?: boolean }): (ms: number) => Promise<boolean> {
  let calls = 0;
  return () => {
    calls += 1;
    return Promise.resolve(calls > 1 ? false : (script.exitedAfterFirstWait ?? true));
  };
}

test('POSIX: SIGTERM within the grace period is a clean group kill', async () => {
  const { killer: tree, script } = killer({});

  const record = await terminateTree({
    child: child(4242),
    strategy: posixTermination(),
    reason: 'timeout',
    waitForExit: exitsWithin({ exitedAfterFirstWait: true }),
    killer: tree,
  });

  assert.deepEqual(record, {
    requested: true,
    reason: 'timeout',
    strategy: 'process-group',
    escalated: false,
    fallbackUsed: false,
    residuePossible: false,
  });
  // Exactly one signal: the grace period worked, so there is nothing to escalate to.
  assert.deepEqual(script.signalled, ['SIGTERM']);
});

test('POSIX: a child that outlives the grace period is escalated to SIGKILL', async () => {
  const { killer: tree, script } = killer({});

  const record = await terminateTree({
    child: child(4242),
    strategy: posixTermination(3_000),
    reason: 'cancel',
    waitForExit: exitsWithin({ exitedAfterFirstWait: false }),
    killer: tree,
  });

  assert.equal(record.escalated, true, 'the grace period expired, so SIGKILL was used');
  assert.equal(record.strategy, 'process-group', 'still a group kill, not a single-process one');
  assert.deepEqual(script.signalled, ['SIGTERM', 'SIGKILL']);
  assert.equal(script.childKills.length, 0);
});

test('POSIX: an unsignalable group falls back to the child and admits residue', async () => {
  const { killer: tree, script } = killer({ signalWorks: false });

  const record = await terminateTree({
    child: child(4242),
    strategy: posixTermination(),
    reason: 'shutdown',
    waitForExit: exitsWithin({ exitedAfterFirstWait: true }),
    killer: tree,
  });

  // "We asked and it did not answer" is not "it is gone" (ADR-014).
  assert.equal(record.strategy, 'single-process');
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.residuePossible, true);
  assert.equal(record.escalated, false, 'no grace period ran, so nothing escalated');
  assert.deepEqual(script.childKills, [1]);
});

test('POSIX: an already-gone group is a success, not an escalation', async () => {
  // ESRCH means nothing in that group survived. Reporting `escalated: true` here would
  // put a SIGKILL in the audit that never happened — and a record that lies about
  // what was done is worse than one that admits ignorance.
  const { killer: tree, script } = killer({});
  let waits = 0;
  const record = await terminateTree({
    child: child(4242),
    strategy: posixTermination(),
    reason: 'timeout',
    waitForExit: () => {
      waits += 1;
      return Promise.resolve(true);
    },
    killer: tree,
  });

  assert.equal(record.escalated, false);
  assert.equal(record.fallbackUsed, false);
  assert.equal(record.residuePossible, false);
  assert.deepEqual(script.signalled, ['SIGTERM']);
  assert.equal(waits, 1);
});

test('Windows: one taskkill /T, called while the child is alive', async () => {
  const { killer: tree, script } = killer({ taskkillCode: 0 });

  const record = await terminateTree({
    child: child(7777),
    strategy: windowsTermination(),
    reason: 'timeout',
    waitForExit: exitsWithin({}),
    killer: tree,
  });

  assert.deepEqual(record, {
    requested: true,
    reason: 'timeout',
    strategy: 'taskkill-tree',
    escalated: false,
    fallbackUsed: false,
    residuePossible: false,
  });
  // The pid is the DIRECT child's: that is the only handle taskkill can walk from,
  // and the research is explicit that it must not be preceded by killing the child.
  assert.deepEqual(script.taskkillCalls, [7777]);
  assert.equal(script.childKills.length, 0);
  // No graceful phase to escalate from: SIGTERM is not catchable on Windows.
  assert.deepEqual(script.signalled, []);
});

test('Windows: taskkill exit 128 means the tree was unreachable, which is residue', async () => {
  const { killer: tree, script } = killer({ taskkillCode: 128 });

  const record = await terminateTree({
    child: child(4242),
    strategy: windowsTermination(),
    reason: 'timeout',
    waitForExit: exitsWithin({}),
    killer: tree,
  });

  // Measured: descendants of cmd.exe / Git Bash / PowerShell survive their parent
  // (12/12 samples), and once the parent is gone taskkill cannot reach them at all.
  // The legacy code swallowed this fallback (mcp.js:285-288); it is reported now.
  assert.equal(record.strategy, 'single-process');
  assert.equal(record.fallbackUsed, true);
  assert.equal(record.residuePossible, true);
  assert.deepEqual(script.childKills, [1]);
});

test('Windows: taskkill that cannot even start is the same honest fallback', async () => {
  const { killer: tree, script } = killer({ taskkillCode: null, taskkillError: 'ENOENT' });

  const record = await terminateTree({
    child: child(4242),
    strategy: windowsTermination(),
    reason: 'shutdown',
    waitForExit: exitsWithin({}),
    killer: tree,
  });

  // A trimmed image without taskkill is a different failure with the same consequence.
  assert.equal(record.residuePossible, true);
  assert.equal(record.fallbackUsed, true);
  assert.deepEqual(script.taskkillCalls.length, 1);
  assert.deepEqual(script.childKills, [1]);
});

test('a child that never got a pid has nothing to terminate, and says so', async () => {
  const { killer: tree, script } = killer({});

  const record = await terminateTree({
    child: child(undefined),
    strategy: posixTermination(),
    reason: 'cancel',
    waitForExit: exitsWithin({}),
    killer: tree,
  });

  // Claiming a strategy here would put "process-group" in an audit for a process that
  // never existed.
  assert.deepEqual(record, {
    requested: true,
    reason: 'cancel',
    strategy: 'none',
    escalated: false,
    fallbackUsed: false,
    residuePossible: false,
  });
  assert.deepEqual(script.signalled, []);
  assert.deepEqual(script.taskkillCalls, []);
  assert.deepEqual(script.childKills, []);
});

test('a run that ended on its own records no termination at all', () => {
  // Distinct from "a termination was requested and succeeded": an audit that cannot
  // tell those apart cannot answer "did anything kill my process?".
  assert.deepEqual(noTermination(), {
    requested: false,
    reason: 'none',
    strategy: 'none',
    escalated: false,
    fallbackUsed: false,
    residuePossible: false,
  });
});

test('the platform decides which strategy is even reachable', () => {
  // The same terminateTree() picks the branch from PlatformPort. This asserts the
  // mapping the adapter relies on, so a change to NodePlatform.termination() that
  // broke the pairing would fail here rather than on a platform nobody tests.
  assert.deepEqual(fakePlatform({ platform: 'linux' }).termination(), posixTermination());
  assert.deepEqual(fakePlatform({ platform: 'windows' }).termination(), windowsTermination());
});