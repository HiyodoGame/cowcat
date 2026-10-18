import { z } from 'zod';
import type { PlatformPort, ProcessPort, ProcessResult, SandboxProfile, ToolGrant, ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

/** The v1 window, kept: 60s by default, 600s at most (agent/src/tools/bash.js:16-17). */
export const BASH_DEFAULT_TIMEOUT_MS = 60_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MIN_TIMEOUT_MS = 1_000;
/** Characters kept per stream by the gateway. The tail is kept and the rest is counted. */
export const BASH_DEFAULT_OUTPUT_CAP = 100_000;

export interface BashToolOptions {
  /** The session's working directory. Commands run here. */
  readonly cwd: string;
  /** The only way to start a child process (ADR-014). */
  readonly process: ProcessPort;
  /** Supplies the shell a command line is handed to (ADR-018). */
  readonly platform: PlatformPort;
  /**
   * The profile this tool runs under, already resolved from config by the composition
   * root (P6). The tool never reads config: "which sandbox" is decided in one place.
   */
  readonly sandbox: SandboxProfile;
  /** What the caller wants the child to see. The gateway redacts it (ADR-015). */
  readonly env?: Readonly<Record<string, string>>;
  readonly outputCap?: number;
}

const DESCRIPTION = [
  'Run a shell command in the session\'s working directory and return stdout, stderr and the exit code.',
  '',
  'When to use: anything that needs a real process — builds, test runners, package managers, git, compilers, formatters, one-off scripts. This is the escape hatch for work no dedicated tool covers.',
  'When NOT to use: reading files (Read), editing files (Edit/Write), finding files (Glob), or searching content (Grep). Dedicated tools are safer and reviewable; shell workarounds for them produce fragile quoting and hide actions in strings.',
  'Command rules:',
  '- Prefer non-interactive invocations. Commands that wait on stdin hang until the timeout kills them.',
  `- timeout defaults to ${String(BASH_DEFAULT_TIMEOUT_MS)}ms, capped at ${String(BASH_MAX_TIMEOUT_MS)}ms — set it explicitly for long builds or test suites.`,
  '- Exit code non-zero is not a tool failure: the result reports it, and many workflows (grep-style probes, test runs) legitimately return non-zero. Interpret it, and show the user the stderr when it matters.',
  '- Destructive or hard-to-reverse commands (recursive deletes, force pushes, history rewrites) warrant an explicit explanation in your visible text before calling.',
  'Not supported: run_in_background. Background tasks are a separate module (P7); passing it is refused rather than ignored.',
  'Failure modes: a timeout means the command was still running — rerun with a longer timeout or a non-interactive form; "command not found" means the toolchain is missing, say so instead of guessing.',
].join('\n');

export function createBashTool(options: BashToolOptions): ToolPort {
  return defineTool(
    {
      name: 'Bash',
      description: DESCRIPTION,
      risk: 'exec',
      commandInput: 'command',
      input: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout: z.number().int().positive().optional().describe(`Timeout in milliseconds (default ${String(BASH_DEFAULT_TIMEOUT_MS)}, max ${String(BASH_MAX_TIMEOUT_MS)})`),
        run_in_background: z
          .boolean()
          .optional()
          .describe('Not supported in this version (background tasks are P7); passing true is refused'),
      }),
    },
    async (input, signal, grant) => {
      if (input.run_in_background === true) {
        return {
          ok: false,
          output:
            'run_in_background is not supported yet: background tasks are a separate module (P7). Run the command in the foreground with an explicit timeout instead.',
        };
      }

      const network = decideNetwork(options.sandbox, grant);
      if (typeof network === 'string') return { ok: false, output: network };

      const shell = options.platform.resolveShell();
      const timeoutMs = clampTimeout(input.timeout);
      const outputCap = options.outputCap ?? BASH_DEFAULT_OUTPUT_CAP;
      const spec = {
        // argv, not a command line: the gateway never spawns through a shell, so the
        // shell is named here and the command is one argument to it (ADR-014/ADR-018).
        argv: [shell.executable, ...shell.baseArgs, shell.commandFlag, input.command],
        cwd: options.cwd,
        env: options.env ?? currentEnv(),
        timeoutMs,
        outputCap,
        sandbox: network,
      };

      let result: ProcessResult;
      try {
        result = await options.process.run(spec, signal);
      } catch (error) {
        return { ok: false, output: `failed to start command: ${error instanceof Error ? error.message : String(error)}` };
      }

      const terminated =
        result.termination.reason === 'timeout' || result.termination.reason === 'cancel';
      return {
        // A non-zero exit is a result the model interprets; a timeout or a cancel means
        // the command did not finish, which is a failure of the call (v1 drew the line
        // in the same place).
        ok: !terminated,
        output: render(result, timeoutMs, outputCap),
        facts: {
          sandbox: result.sandbox,
          termination: result.termination,
          removedEnv: result.removedEnv,
          ignoredDeny: result.ignoredDeny,
        },
        truncation: {
          truncated: result.truncated,
          dropped: result.truncated ? result.dropped.stdout + result.dropped.stderr : 0,
          reason: result.truncated ? `bash: output cap (${String(outputCap)} characters per stream)` : null,
        },
      };
    },
  );
}

/**
 * What the network setting means for THIS call (ADR-051).
 *
 * `ask` is the whole reason the grant exists: the profile says "per approved command",
 * the kernel knows whether this command was approved, and the tool is the only place
 * that can put the two together. When there is no grant the answer is a refusal with
 * the reason — never a quiet downgrade to `off`, which would make the executor's own
 * promise ("grants it per approved command") false.
 */
function decideNetwork(sandbox: SandboxProfile, grant: ToolGrant): SandboxProfile | string {
  if (sandbox.network !== 'ask') return sandbox;
  if (grant.networkApproved) return { ...sandbox, network: 'on' };
  return [
    'refusing to run: the sandbox profile asks for network per approved command (network: "ask"), and this call carries no approval.',
    'Running it with the network silently switched off would be a downgrade you did not choose; set the sandbox network to "off" or "on", or let the command be approved when it is asked about.',
  ].join(' ');
}

function clampTimeout(requested: number | undefined): number {
  const value = requested ?? BASH_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, BASH_MIN_TIMEOUT_MS), BASH_MAX_TIMEOUT_MS);
}

// The caller's environment, filtered to real strings: `process.env` has `undefined`
// values, and the gateway takes `Record<string, string>`.
function currentEnv(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function render(
  result: Awaited<ReturnType<ProcessPort['run']>>,
  timeoutMs: number,
  outputCap: number,
): string {
  const parts: string[] = [];
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (stdout !== '') parts.push(stdout);
  if (stderr !== '') parts.push(`stderr: ${stderr}`);
  if (result.exitCode !== null && result.exitCode !== 0) parts.push(`exit code: ${String(result.exitCode)}`);
  if (result.signal !== null) parts.push(`signal: ${result.signal}`);
  if (result.termination.reason === 'timeout') {
    parts.push(`[terminated: timeout after ${String(timeoutMs)}ms — the command was still running]`);
  }
  if (result.termination.reason === 'cancel') parts.push('[terminated: cancelled]');
  if (result.termination.residuePossible) {
    parts.push('[termination could not be proven; descendants may still be running]');
  }
  // Only the OS-level tier is worth a line here: `light` means redaction and nothing
  // more, and a note that reads like "sandboxed" would be exactly the false comfort
  // ADR-007 forbids.
  if (result.sandbox.mode === 'system') {
    parts.push(`[sandboxed: ${result.sandbox.backend ?? 'unknown backend'}]`);
  }
  if (result.truncated) {
    parts.push(
      `[output truncated at ${String(outputCap)} characters per stream: ${String(result.dropped.stdout)} stdout + ${String(result.dropped.stderr)} stderr dropped]`,
    );
  }
  if (result.sandbox.limitations.length > 0) {
    parts.push(`[sandbox limitations: ${result.sandbox.limitations.join('; ')}]`);
  }
  return parts.length === 0 ? '(no output)' : parts.join('\n');
}