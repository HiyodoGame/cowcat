// Bash tool: run shell commands with timeout limits and dangerous-command detection.
import { exec } from 'node:child_process';
import { decodeOutput } from '../textdecode.js';
import { classifyCommand, auditRecord, sandboxFor, sandboxEnv, sandboxBlockMessage } from '../sandbox.js';

export const DEFAULT_TIMEOUT = 60_000;
export const MAX_TIMEOUT = 600_000;
// Background tasks get their own tier (claude 2.1.296): default 30min, cap 2h.
export const BACKGROUND_DEFAULT_TIMEOUT = 1_800_000;
export const BACKGROUND_MAX_TIMEOUT = 7_200_000;

export function resolveTimeout(timeout, { background = false } = {}) {
  const def = background ? BACKGROUND_DEFAULT_TIMEOUT : DEFAULT_TIMEOUT;
  const max = background ? BACKGROUND_MAX_TIMEOUT : MAX_TIMEOUT;
  return Math.min(Math.max(timeout || def, 1000), max);
}

export const BashTool = {
  name: 'Bash',
  description: `Run a shell command in the session's working directory and return stdout, stderr and the exit code.

When to use: anything that needs a real process — builds, test runners, package managers, git, compilers, formatters, one-off scripts. This is the escape hatch for work no dedicated tool covers.
When NOT to use: reading files (Read), editing files (Edit/Write), finding files (Glob), or searching content (Grep). Dedicated tools are safer and reviewable; shell workarounds for them produce fragile quoting and hide actions in strings.
Command rules:
- Prefer non-interactive invocations. Commands that wait on stdin hang until the timeout kills them.
- timeout defaults to 60s, capped at 600s — set it explicitly for long builds or test suites. Background commands (run_in_background) default to 1800s and cap at 7200s.
- Exit code non-zero is not a tool failure: the result reports it, and many workflows (grep-style probes, test runs) legitimately return non-zero. Interpret it, and show the user the stderr when it matters.
- Destructive or hard-to-reverse commands (recursive deletes, force pushes, history rewrites) warrant an explicit explanation in your visible text before calling.
Failure modes: timeouts mean the command was still running — rerun with a longer timeout or a non-interactive form; "command not found" means the toolchain is missing, say so instead of guessing.`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (foreground: default 60000, max 600000; background: default 1800000, max 7200000)' },
      description: { type: 'string', description: 'Short active-voice description of what the command does' },
      run_in_background: { type: 'boolean', description: 'Run detached and return immediately; read the output later with TaskOutput, stop it with TaskStop' },
    },
    required: ['command'],
  },
  execute(input, ctx) {
    // P4 sandbox (light by default): static triage + secret-stripped env +
    // audit trail. classifyCommand/audit/sandboxEnv are fail-open; only the
    // dangerous gate fails closed. See src/sandbox.js for the threat model.
    const sb = sandboxFor(ctx.config);
    const classification = classifyCommand(input.command || '', { cwd: ctx.cwd });
    if (sb.mode === 'light' && classification.risk === 'dangerous') {
      auditRecord({ command: input.command, cwd: ctx.cwd, risk: 'dangerous', decision: 'blocked' });
      return Promise.resolve({ ok: false, error: sandboxBlockMessage(classification) });
    }
    auditRecord({
      command: input.command, cwd: ctx.cwd, risk: classification.risk,
      decision: classification.risk === 'elevated' ? 'elevated-run' : 'run',
    });
    const childEnv = sandboxEnv({ ...process.env, ...ctx.env }, sb);
    if (input.run_in_background && ctx.background) {
      const task = ctx.background.start(input.command, { cwd: ctx.cwd, timeout: resolveTimeout(input.timeout, { background: true }), env: childEnv });
      return { ok: true, output: `已后台启动 ${task.id}，用 TaskOutput 查看` };
    }
    const timeout = resolveTimeout(input.timeout);
    return new Promise((resolve) => {
      let child;
      try {
        child = exec(input.command, {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer', // raw bytes: decodeOutput handles GBK codepages
          env: childEnv,
        }, (err, stdout, stderr) => {
          if (err?.killed) {
            resolve({ ok: false, error: `Command timed out after ${timeout}ms` });
            return;
          }
          const code = err?.code ?? 0;
          const outText = decodeOutput(stdout).trimEnd();
          const errText = decodeOutput(stderr).trimEnd();
          const out = [
            outText,
            errText ? `stderr: ${errText}` : '',
            code !== 0 ? `exit code: ${code}` : '',
          ].filter(Boolean).join('\n');
          resolve({
            ok: true,
            output: out || '(no output)',
            exitCode: code,
            stdout: outText,
            stderr: errText,
          });
        });
      } catch (e) {
        resolve({ ok: false, error: `Failed to start command: ${e.message}` });
        return;
      }
      ctx.trackProcess?.(child);
    });
  },
};
