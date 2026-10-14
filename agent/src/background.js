// Background task registry (TaskOutput/TaskStop + /tasks). Bash commands run
// with run_in_background land here; the CLI SIGKILLs everything left on exit.
import { exec } from 'node:child_process';

const MAX_OUTPUT = 20_000;
const MAX_TIMEOUT = 7_200_000; // background tier: Bash passes its own default (1800s); this is the hard cap
let seq = 0;

export class BackgroundRegistry {
  constructor() {
    this.tasks = new Map();
  }

  start(command, { cwd, timeout = 1_800_000, env } = {}) {
    const taskId = `task_${Date.now().toString(36)}_${++seq}`;
    const task = {
      id: taskId,
      command,
      cwd,
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
      exitCode: null,
      done: false,
      killed: false,
      child: null,
    };
    const cap = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT);
    task.timer = setTimeout(() => this.stop(taskId, { silent: true }), cap);
    if (task.timer.unref) task.timer.unref();
    task.child = exec(command, { cwd, env: { ...process.env, ...(env || {}) }, maxBuffer: 20 * 1024 * 1024, windowsHide: true, detached: process.platform !== 'win32' }, (err, stdout, stderr) => {
      task.done = true;
      task.exitCode = err?.killed ? null : (err?.code ?? 0);
      task.stdout = stdout || '';
      task.stderr = stderr || '';
      clearTimeout(task.timer);
    });
    this.tasks.set(taskId, task);
    return task;
  }

  get(id) { return this.tasks.get(id); }

  // Run an async function as a background task (used by the Agent tool's
  // run_in_background). The record is shaped like a shell task — stdout holds
  // the resolved value, stderr the failure — so TaskOutput/TaskStop work
  // against it unchanged.
  startAsync(fn, { timeout = MAX_TIMEOUT, description = '' } = {}) {
    const taskId = `task_${Date.now().toString(36)}_${++seq}`;
    const task = {
      id: taskId,
      command: description || '(async task)',
      cwd: null,
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
      exitCode: null,
      done: false,
      killed: false,
      child: null,
    };
    const cap = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT);
    task.timer = setTimeout(() => this.stop(taskId, { silent: true }), cap);
    if (task.timer.unref) task.timer.unref();
    Promise.resolve()
      .then(fn)
      .then((out) => {
        task.done = true;
        task.stdout = String(out ?? '');
        task.exitCode = 0;
        clearTimeout(task.timer);
      })
      .catch((e) => {
        task.done = true;
        task.stderr = e?.message || String(e);
        task.exitCode = 1;
        clearTimeout(task.timer);
      });
    this.tasks.set(taskId, task);
    return task;
  }


  list() {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  stop(id, { silent = false } = {}) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.killed = true;
    try {
      if (process.platform === 'win32') {
        // kill the whole tree: cmd wrapper + grandchildren
        exec(`taskkill /pid ${task.child.pid} /T /F`, () => {});
      } else {
        try { process.kill(-task.child.pid, 'SIGKILL'); } catch { task.child.kill('SIGKILL'); }
      }
    } catch { /* noop */ }
    clearTimeout(task.timer);
    task.done = true;
    task.exitCode = task.exitCode ?? (silent ? null : 137);
    if (!silent) this.tasks.delete(id);
    return task;
  }

  snapshot(task) {
    const out = [
      task.stdout,
      task.stderr ? `stderr: ${task.stderr}` : '',
      task.exitCode != null ? `exit code: ${task.exitCode}` : '',
      task.killed ? '(killed)' : '',
    ].filter(Boolean).join('\n') || '(no output yet)';
    return { running: !task.done, exitCode: task.exitCode, output: out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[truncated]` : out };
  }

  async wait(task, timeoutMs) {
    const t0 = Date.now();
    while (!task.done) {
      if (Date.now() - t0 >= timeoutMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.snapshot(task);
  }

  killAll() {
    for (const task of this.tasks.values()) this.stop(task.id, { silent: true });
    this.tasks.clear();
  }
}
