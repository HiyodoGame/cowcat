// NodeProcess — the Node implementation of ProcessPort (P2 T4, ADR-014).
//
// One gateway, and every child goes through it. The legacy agent spawned from nine
// places and had three termination behaviours; that table is in
// research/p2-ports.md §2.1 and this file is the replacement.
//
// What the gateway owns, because a caller must not be able to get it wrong:
//   * env redaction (ADR-015) — light AND system, never off. The caller assembles
//     `spec.env` as it likes; what the child sees is decided here, and what was
//     removed comes back as names so it can be logged.
//   * output capping — the tail, and the count of what was dropped.
//   * termination — one path, for timeout and cancel alike (ADR-014).
//
// What it deliberately does NOT do: build argv. `spec.argv` arrives pure, and the
// shell that runs a command line is the caller's business via PlatformPort — which
// is what keeps the sandbox policy→argv mapping a pure function (01-layers.md,
// ADR-017). This file also never spawns through a shell: `shell: true` re-quotes
// the command, makes Node refuse `.cmd` shims (CVE-2024-27980) and lets the cwd
// shadow what we meant to run.
//
// Sandboxing is T5's job. Until an executor is injected, a `system` run is REFUSED
// with the reason attached — never quietly downgraded to `light`, which is the whole
// point of ADR-016. `light` in the meantime means what it always meant: redaction
// and nothing more. Its copy must never imply OS-level isolation.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { SandboxUnavailableError, type PlatformPort, type ProcessPort, type ProcessResult, type ProcessSpec, type TerminationReason, type TerminationRecord } from '../ports/index.js';
import { redactEnv } from '../policy/env.js';
import { OutputTail } from './output-tail.js';
import { noTermination, nodeTreeKiller, terminateTree, type TreeKiller } from './terminate.js';

/**
 * The `argv` a sandbox-wrapped run executes. T5 supplies one of these per backend;
 * T4 only needs the shape, which is why it is a plain function and not a port.
 */
export type SandboxCommandResolver = (spec: ProcessSpec) => { readonly argv: readonly string[] };

export interface NodeProcessOptions {
  readonly platform: PlatformPort;
  /** Supplied in T5. Without it, `system` is refused as not-implemented. */
  readonly sandboxCommand?: SandboxCommandResolver;
  readonly treeKiller?: TreeKiller;
}

export class NodeProcess implements ProcessPort {
  readonly #platform: PlatformPort;
  readonly #sandboxCommand: SandboxCommandResolver | null;
  readonly #killer: TreeKiller;

  constructor(options: NodeProcessOptions) {
    this.#platform = options.platform;
    this.#sandboxCommand = options.sandboxCommand ?? null;
    this.#killer = options.treeKiller ?? nodeTreeKiller;
  }

  async run(spec: ProcessSpec, signal: AbortSignal): Promise<ProcessResult> {
    const argv = this.#resolveArgv(spec);
    const command = argv[0];
    // An empty argv has no executable, and spawn's own error for it says nothing
    // about which run was at fault. One line here beats a stack trace from deep inside.
    if (command === undefined) throw new Error('ProcessSpec.argv is empty: there is no executable to run');
    // `off` is the one mode whose contract is "run the command as-is"; light and
    // system both redact (ADR-015), which is the coverage the legacy version lacked.
    const redaction =
      spec.sandbox.mode === 'off'
        ? { env: spec.env, removed: [] as readonly string[], ignoredDeny: [] as readonly string[] }
        : redactEnv(spec.env, { deny: spec.sandbox.env.deny });

    const stdout = new OutputTail(spec.outputCap ?? Number.POSITIVE_INFINITY);
    const stderr = new OutputTail(spec.outputCap ?? Number.POSITIVE_INFINITY);

    // Already cancelled: do not start a process in order to kill it. The record says
    // the request was cancelled rather than claiming a termination that never ran.
    if (signal.aborted) {
      return this.#result(null, null, stdout, stderr, redaction, {
        requested: true,
        reason: 'cancel',
        strategy: 'none',
        escalated: false,
        fallbackUsed: false,
        residuePossible: false,
      });
    }

    // A pipe we never write to must not become an uncaught exception. Node reports
    // EPIPE (and ECONNRESET) on a child pipe as an uncaught error by default, and a
    // gateway that crashes the whole program because a child closed its stdin early
    // is a gateway nobody can use — measured on macOS, where a child that exits
    // without reading stdin makes `end()` raise synchronously.
    const child = spawn(command, argv.slice(1), {
      cwd: spec.cwd,
      // Spread into a fresh object: spawn wants a mutable ProcessEnv, and handing it
      // the caller's own map (or a readonly one) is how a child ends up inheriting a
      // key the gateway just decided to strip.
      env: { ...redaction.env },
      // All three pipes, always. stdin is closed immediately when nothing was handed
      // over, which reads as EOF exactly like an ignored stdin does — and a uniform
      // stdio keeps one spawn overload instead of a branch per mode.
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: its own process group, so kill(-pgid) covers the descendants.
      // Windows: NOT detached — there is no group to have, and a new console would
      // only change what taskkill can see.
      detached: this.#platform.platform !== 'windows',
      windowsHide: true,
      shell: false,
    });
    child.stdin.on('error', () => {
      // Nothing the caller can do about a child that will not take its input. The
      // command's own output is the result; a failed write to a pipe we opened is not.
    });

    child.stdin.end(spec.stdin ?? '');

    // StringDecoder, not chunk.toString(): a multi-byte character split across two
    // reads would otherwise become replacement characters in the output we report.
    const decodeStdout = new StringDecoder('utf8');
    const decodeStderr = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(decodeStdout.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(decodeStderr.write(chunk));
    });

    // 'close', not 'exit': close is when the pipes are drained, so the output is
    // complete when the caller reads it.
    const closed = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
      child.once('close', (code, childSignal) => {
        // Flush a decoder that ends mid-character so nothing is silently lost.
        stdout.push(decodeStdout.end());
        stderr.push(decodeStderr.end());
        resolve({ code, signal: childSignal });
      });
    });

    const strategy = this.#platform.termination();
    const waitForExit = async (ms: number): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, ms);
      });
      try {
        return await Promise.race([closed.then(() => true), expired]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    // A holder rather than a bare `let`: the promise is only ever assigned inside a
// callback, and control-flow analysis would narrow a local to `null` forever and
// quietly drop the record of every real termination. Property reads are reset by
// intervening calls, so the narrowing does not lie here.
const termination: { current: Promise<TerminationRecord> | null } = { current: null };
    // `??=` so timeout and cancel cannot each start a termination: ADR-014's "one
    // terminate()" is enforced by the assignment, not by hoping callers cooperate.
    const terminateOnce = (reason: TerminationReason): Promise<TerminationRecord> => {
      termination.current ??= terminateTree({ child, strategy, reason, waitForExit, killer: this.#killer });
      return termination.current;
    };

    const onAbort = (): void => {
      void terminateOnce('cancel');
    };
    const timer =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            void terminateOnce('timeout');
          }, spec.timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // A child that cannot be STARTED is a rejection; everything after that is a
      // result, because the caller has to report a non-zero exit to the model just
      // as faithfully as a success (ProcessPort.run's contract).
      const spawnFailure = new Promise<never>((_resolve, reject) => {
        child.once('error', reject);
      });
      const outcome = await Promise.race([closed, spawnFailure]);
      const record = termination.current === null ? noTermination() : await termination.current;
      return this.#result(outcome.code, outcome.signal, stdout, stderr, redaction, record);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  #resolveArgv(spec: ProcessSpec): readonly string[] {
    return spec.sandbox.mode === 'system' ? this.#sandboxArgv(spec) : spec.argv;
  }

  #sandboxArgv(spec: ProcessSpec): readonly string[] {
    if (this.#sandboxCommand !== null) return this.#sandboxCommand(spec).argv;

    // Refused, never downgraded: a run that silently loses OS-level isolation while
    // reporting "sandbox on" is exactly the failure ADR-016 exists to prevent.
    //
    // Two different reasons, because they need different fixes. `unsupported-platform`
    // means this machine has no backend and never will — on Windows that is decided,
    // not discovered (ADR-007), so the platform answers even when the probe list is
    // empty. `not-implemented` means a backend exists and this build has no executor
    // for it yet, which only T5 can change.
    const backends = this.#platform.sandboxBackends();
    const usable = backends.find((verdict) => verdict.usable);
    const first = backends[0];
    const unsupported = this.#platform.platform === 'windows' || first?.reason === 'unsupported-platform';
    throw new SandboxUnavailableError(
      usable?.name ?? first?.name ?? null,
      unsupported ? 'unsupported-platform' : 'not-implemented',
      unsupported
        ? (first?.detail ?? 'no OS-level sandbox backend exists on this platform')
        : 'the v2 sandbox executor lands in P2 T5; this build redacts but does not isolate',
      [WSL_ALTERNATIVE, LIGHT_ALTERNATIVE],
    );
  }

  #result(
    exitCode: number | null,
    signal: string | null,
    stdout: OutputTail,
    stderr: OutputTail,
    redaction: { readonly removed: readonly string[]; readonly ignoredDeny: readonly string[] },
    termination: TerminationRecord,
  ): ProcessResult {
    return {
      exitCode,
      signal,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      dropped: { stdout: stdout.dropped, stderr: stderr.dropped },
      removedEnv: redaction.removed,
      ignoredDeny: redaction.ignoredDeny,
      termination,
    };
  }
}

const WSL_ALTERNATIVE = 'run inside WSL2 — the bubblewrap backend works there';
const LIGHT_ALTERNATIVE = "keep the light tier, whose copy does not claim OS-level isolation (redaction still applies)";