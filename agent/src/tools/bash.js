// Bash tool: run shell commands with timeout limits and dangerous-command detection.
import { exec, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeOutput } from '../textdecode.js';
import {
  classifyCommand, auditRecord, sandboxFor, sandboxEnv, sandboxBlockMessage,
  sandboxUnavailableMessage, sandboxDegradedNote,
} from '../sandbox.js';
import { planBashCommand, toShellCommand } from '../sandbox/exec.js';
import { sandboxProbe } from '../sandbox/probe.js';
import { detectViolations, sandboxNote } from '../sandbox/violations.js';
import { canonicalPath } from '../canonical.js';

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
    // Sandbox layers, in order of strength:
    //   light (default)  — static triage + secret-stripped env + audit trail
    //   system (opt-in)  — the same, plus an OS-level backend that actually
    //                      isolates the process tree (src/sandbox/*)
    // classifyCommand/audit/sandboxEnv are fail-open; the dangerous gate fails
    // closed, and so does a system run whose backend is unavailable when the
    // policy says failOpen:false. See src/sandbox.js for the threat model.
    const sb = sandboxFor(ctx.config, { cwd: ctx.cwd });
    const classification = classifyCommand(input.command || '', { cwd: ctx.cwd });
    if (sb.mode === 'light' && classification.risk === 'dangerous') {
      auditRecord({ command: input.command, cwd: ctx.cwd, risk: 'dangerous', decision: 'blocked' });
      return Promise.resolve({ ok: false, error: sandboxBlockMessage(classification) });
    }

    // macOS has no mount namespaces, so there is no way to hand the sandbox a
    // private /tmp the way bubblewrap's `--tmpfs /tmp` does. The faithful
    // equivalent is an empty directory that belongs to this one call: the
    // backend grants write access to exactly it, TMPDIR points at it, and it is
    // removed when the command is done. The host's per-user temp area stays
    // outside the sandbox — the same property the Linux side gets from the
    // tmpfs, and the same reason that side refused to bind the host tmpdir back.
    const probe = sandboxProbe();
    const needsPrivateTmp = sb.mode === 'system'
      && (sb.backend === 'seatbelt' || (sb.backend === 'auto' && probe.usable === 'seatbelt'));
    let privateTmpDir = null;
    if (needsPrivateTmp) {
      try {
        privateTmpDir = canonicalPath(mkdtempSync(join(tmpdir(), 'cowcat-sbx-')));
      } catch {
        privateTmpDir = null; // degrade: the command still runs, just without scratch space
      }
    }
    const dropTmp = () => {
      if (!privateTmpDir) return;
      try { rmSync(privateTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      privateTmpDir = null;
    };

    const plan = planBashCommand({
      policy: sb, probe, command: input.command || '', cwd: ctx.cwd,
      // The loop sets this for a single approved call (Phase 1b): in `network:
      // 'ask'` mode the prompt is where the network namespace comes from.
      networkGranted: ctx.networkApproved === true,
      tmpDir: privateTmpDir,
    });
    if (plan.kind !== 'wrapped') dropTmp();
    // A system run without a usable backend: fall back (and SAY SO) or refuse.
    // The degrade note is what separates us from agents that silently run
    // unsandboxed while their UI still claims a sandbox (research §7.8).
    const degraded = plan.kind === 'unavailable' ? plan : null;
    // `degradable: false` means falling back would be WORSE than refusing: it is
    // a configuration this backend cannot honour (macOS + network "on"), and
    // light mode would drop the filesystem isolation while keeping the network —
    // strictly more access than the user asked for. Refuse and say why.
    if (degraded && (!sb.failOpen || degraded.degradable === false)) {
      dropTmp();
      auditRecord({
        command: input.command, cwd: ctx.cwd, risk: classification.risk,
        decision: 'blocked', mode: sb.mode, network: sb.network,
        ...(degraded.backend ? { backend: degraded.backend } : {}),
      });
      return Promise.resolve({ ok: false, error: sandboxUnavailableMessage(degraded, sb) });
    }

    const decision = classification.risk === 'elevated' ? 'elevated-run' : 'run';
    const runNetwork = plan.network ?? sb.network;
    auditRecord({
      command: input.command, cwd: ctx.cwd, risk: classification.risk, decision,
      ...(sb.mode === 'system' ? { mode: sb.mode, network: runNetwork } : {}),
      ...(plan.kind === 'wrapped' ? { backend: plan.backend } : {}),
    });
    // The backend's own env (TMPDIR → the private scratch dir) is merged LAST, so a
    // stray TMPDIR inherited from the parent process cannot point the sandboxed
    // toolchain at the host temp area we just kept out of the profile.
    const childEnv = { ...sandboxEnv({ ...process.env, ...ctx.env }, sb), ...(plan.env || {}) };
    const wrapped = plan.kind === 'wrapped';
    const degradeNote = degraded ? `\n${sandboxDegradedNote(degraded, sb)}` : '';

    if (input.run_in_background && ctx.background) {
      // Background tasks are handed to a shell (src/background.js uses exec), so
      // the wrapped argv has to be quoted back into a command string.
      const cmd = wrapped ? toShellCommand(plan.file, plan.args) : input.command;
      // The private scratch dir has to outlive this call — the task is still
      // running — so it is cleaned up when the task exits, not here.
      const task = ctx.background.start(cmd, { cwd: ctx.cwd, timeout: resolveTimeout(input.timeout, { background: true }), env: childEnv, onExit: dropTmp });
      return { ok: true, output: `已后台启动 ${task.id}，用 TaskOutput 查看${degradeNote}` };
    }
    const timeout = resolveTimeout(input.timeout);
    return new Promise((resolve) => {
      let child;
      const onDone = (err, stdout, stderr) => {
        dropTmp();
        if (err?.killed) {
          resolve({ ok: false, error: `Command timed out after ${timeout}ms` });
          return;
        }
        const code = err?.code ?? 0;
        const outText = decodeOutput(stdout).trimEnd();
        const errText = decodeOutput(stderr).trimEnd();
        // Denials come back as the command's own errors (bwrap reports nothing),
        // so this is pattern matching over stderr and the note says "likely".
        const violations = wrapped ? detectViolations(errText) : [];
        const note = wrapped
          ? sandboxNote({ policy: sb, backend: plan.backend, violations, limitations: plan.limitations || [] })
          : '';
        if (violations.length) {
          // Second audit line, written only when something was refused: keeps the
          // one-line-per-run shape for normal runs while recording the evidence.
          auditRecord({
            command: input.command, cwd: ctx.cwd, risk: classification.risk,
            decision: 'violation', mode: sb.mode, backend: plan.backend, network: runNetwork, violations,
          });
        }
        const out = [
          outText,
          errText ? `stderr: ${errText}` : '',
          code !== 0 ? `exit code: ${code}` : '',
          violations.length ? note : '',
          degradeNote.trim(),
        ].filter(Boolean).join('\n');
        resolve({
          ok: true,
          output: out || '(no output)',
          exitCode: code,
          stdout: outText,
          stderr: errText,
        });
      };
      try {
        const opts = {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          env: childEnv,
        };
        // execFile for the wrapped form: argv goes straight to bwrap, no shell
        // re-parsing of flags or of the model's command.
        child = wrapped
          ? execFile(plan.file, plan.args, opts, onDone)
          : exec(input.command, { ...opts, encoding: 'buffer' }, onDone); // raw bytes: decodeOutput handles GBK codepages
      } catch (e) {
        resolve({ ok: false, error: `Failed to start command: ${e.message}` });
        return;
      }
      ctx.trackProcess?.(child);
    });
  },
};
