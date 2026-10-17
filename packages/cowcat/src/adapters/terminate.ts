// The ONE termination path (P2 T4, ADR-014).
//
// The legacy code had three of these, in three files, and two real orphan bugs
// (research/p2-ports.md §2.1). Everything that ends a child — a timeout, an
// AbortSignal, a shutdown, an explicit stop — comes through here, and every rule
// below is a measured boundary rather than a preference:
//
//   * WINDOWS: `taskkill /T /F` enumerates by the parent→child relation, so it MUST
//     be called while the direct child is still alive. Once the parent is gone it
//     exits 128 ("no process found") and the tree is unreachable forever — and
//     descendants of `cmd.exe` / Git Bash / PowerShell DO survive their parent
//     (12/12 samples, appendix B-A). Therefore this file never does "kill the child,
//     then tree-kill": that two-step order is the bug, not a fallback.
//   * POSIX: `kill(-pgid)` covers the process group and nothing else. A descendant
//     that called `setsid()` leaves the group, survives, and after its parent dies
//     cannot even be found by walking ppid (appendix B-B). The port documents that
//     boundary instead of implying everything dies.
//   * WINDOWS has no graceful phase at all: SIGTERM is not catchable there
//     (measured — a child with a SIGTERM handler never reached the handler), so
//     `/F` is the only semantics available and there is nothing to escalate from.
//
// The `TreeKiller` seam exists so this protocol can be tested where the bugs are —
// the escalation arithmetic and the ESRCH/128 branches — without spawning anything
// and without a Windows machine. nodeTreeKiller is the real one.

import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TerminationReason, TerminationRecord, TerminationStrategy } from '../ports/index.js';

// After SIGKILL (or `/F`) the process is gone; this is only long enough for the
// stdio pipes to close so 'close' fires and the caller can resolve. A kill that
// "did nothing" shows up as a live child within this window.
const SETTLE_MS = 500;

// taskkill is a process spawn of its own. Generous, because Defender can scan it on
// a cold start, and short enough that a wedged taskkill cannot outlive the thing it
// was asked to kill.
const TASKKILL_TIMEOUT_MS = 10_000;

export interface TreeKiller {
  /**
   * POSIX: signal the child's whole process group.
   *
   * Returns true when the signal was delivered OR the group no longer exists —
   * ESRCH means nothing in that group survived, which is a successful termination
   * and must not be reported as a failure or as an escalation. False is reserved
   * for "the group exists and we may not signal it" (EPERM), which is the one case
   * that has to fall back.
   */
  readonly signalGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => boolean;

  /**
   * Windows: one `taskkill /pid N /T /F`. `code` is taskkill's own exit status
   * (0 = the tree was terminated, 128 = no process found); `error` is non-null when
   * taskkill could not be started at all — a trimmed image without it.
   */
  readonly taskkillTree: (pid: number) => { readonly code: number | null; readonly error: string | null };

  /** Last resort: the direct child only. Descendants may survive; that is what `residuePossible` reports. */
  readonly killChild: (child: ChildProcess) => boolean;
}

export const nodeTreeKiller: TreeKiller = {
  signalGroup: (pid, signal) => {
    try {
      // Negative pid = the process group, which is why the child was spawned detached.
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH means "no such process group", i.e. nothing in it survived — a successful
      // termination. NOT on Windows, though: there are no process groups, a negative
      // pid is meaningless, and the failure can surface as ESRCH too. Reading that as
      // success would report a kill that never happened — found by a test that used a
      // POSIX strategy on this machine and watched the child outlive its timeout.
      return code === 'ESRCH' && process.platform !== 'win32';
    }
  },

  taskkillTree: (pid) => {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS,
    });
    // Nothing here parses taskkill's output, which is deliberate: on a Chinese
    // Windows it is OEM code page 936 and decoding it as UTF-8 is mojibake
    // (research/p2-ports.md appendix B). The exit status is the whole contract here.
    return { code: result.status, error: result.error?.message ?? null };
  },

  killChild: (child) => {
    try {
      return child.kill('SIGKILL');
    } catch {
      return false;
    }
  },
};

/** A run that ended without anyone asking: the child exited on its own. */
export function noTermination(): TerminationRecord {
  return {
    requested: false,
    reason: 'none',
    strategy: 'none',
    escalated: false,
    fallbackUsed: false,
    residuePossible: false,
  };
}

/**
 * Terminate the tree, once. Never retried, never reordered.
 *
 * `waitForExit` is supplied by the caller because only the caller knows when the
 * child's streams have closed — and "the child is gone" has to mean closed, not
 * exited, or a late write would be lost from the output the caller reports.
 */
export async function terminateTree(options: {
  readonly child: ChildProcess;
  readonly strategy: TerminationStrategy;
  readonly reason: TerminationReason;
  readonly waitForExit: (ms: number) => Promise<boolean>;
  readonly killer?: TreeKiller;
}): Promise<TerminationRecord> {
  const { child, strategy, reason, waitForExit } = options;
  const killer = options.killer ?? nodeTreeKiller;
  const pid = child.pid;

  // No pid means the child never started, or was already reaped. There is no tree to
  // reach, and claiming otherwise would put a strategy in the audit that did nothing.
  if (pid === undefined) {
    return { requested: true, reason, strategy: 'none', escalated: false, fallbackUsed: false, residuePossible: false };
  }

  return strategy.kind === 'process-group'
    ? terminateGroup(child, pid, reason, strategy, waitForExit, killer)
    : terminateTaskkillTree(child, pid, reason, waitForExit, killer);
}

async function terminateGroup(
  child: ChildProcess,
  pid: number,
  reason: TerminationReason,
  strategy: TerminationStrategy,
  waitForExit: (ms: number) => Promise<boolean>,
  killer: TreeKiller,
): Promise<TerminationRecord> {
  const signalled = killer.signalGroup(pid, 'SIGTERM');

  // The group could not be signalled at all. Fall back to the direct child and say
  // so: the group still exists and something in it may well be running.
  if (!signalled) {
    killer.killChild(child);
    await waitForExit(SETTLE_MS);
    return { requested: true, reason, strategy: 'single-process', escalated: false, fallbackUsed: true, residuePossible: true };
  }

  if (!strategy.supportsGraceful) {
    killer.signalGroup(pid, 'SIGKILL');
    await waitForExit(SETTLE_MS);
    return { requested: true, reason, strategy: 'process-group', escalated: false, fallbackUsed: false, residuePossible: false };
  }

  if (await waitForExit(strategy.graceMs)) {
    return { requested: true, reason, strategy: 'process-group', escalated: false, fallbackUsed: false, residuePossible: false };
  }

  // SIGTERM was ignored or handled into a long exit. SIGKILL cannot be caught, so
  // after this the group is empty — a `setsid()` descendant is outside the group and
  // remains uncovered by contract, which is a documented limit rather than a residue
  // we failed to prove.
  killer.signalGroup(pid, 'SIGKILL');
  await waitForExit(SETTLE_MS);
  return { requested: true, reason, strategy: 'process-group', escalated: true, fallbackUsed: false, residuePossible: false };
}

async function terminateTaskkillTree(
  child: ChildProcess,
  pid: number,
  reason: TerminationReason,
  waitForExit: (ms: number) => Promise<boolean>,
  killer: TreeKiller,
): Promise<TerminationRecord> {
  // ONE call, while the child is still alive. This is the whole reason this function
  // exists: the alternative order (kill the child, then hope a tree kill still works)
  // is what produced the measured 12/12 orphan samples.
  const result = killer.taskkillTree(pid);
  if (result.code === 0) {
    await waitForExit(SETTLE_MS);
    return { requested: true, reason, strategy: 'taskkill-tree', escalated: false, fallbackUsed: false, residuePossible: false };
  }

  // Exit 128 means the tree was already unreachable; a spawn error means taskkill was
  // not there. Neither proves anything is gone, so the direct child is killed and the
  // residue is reported rather than smoothed over — the legacy code swallowed exactly
  // this fallback (`mcp.js:285-288`).
  killer.killChild(child);
  await waitForExit(SETTLE_MS);
  return { requested: true, reason, strategy: 'single-process', escalated: false, fallbackUsed: true, residuePossible: true };
}