// TaskOutput tool: read a background task's current output (optionally blocking).
const MAX_WAIT = 600_000;

export const TaskOutputTool = {
  name: 'TaskOutput',
  description: `Read the output of a background task started by Bash with run_in_background.
Without block, returns immediately with whatever the task has produced so far (running: true while it is still going). With block: true, waits for completion or the given timeout before returning. Output is truncated at 20000 characters.`,
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The background task id (shown when the task started)' },
      block: { type: 'boolean', description: 'Wait for the task to finish (bounded by timeout)' },
      timeout: { type: 'number', description: 'Max wait in milliseconds when blocking (default 60000, max 600000)' },
    },
    required: ['task_id'],
  },
  async execute(input, ctx) {
    const reg = ctx.background;
    if (!reg) return { ok: false, error: 'Background tasks are not available in this context' };
    const task = reg.get(input.task_id);
    if (!task) return { ok: false, error: `Unknown task: ${input.task_id}` };
    if (input.block) {
      const waitMs = Math.min(Math.max(input.timeout || 60_000, 1000), MAX_WAIT);
      const snap = await reg.wait(task, waitMs);
      return { ok: true, output: JSON.stringify(snap, null, 2) };
    }
    return { ok: true, output: JSON.stringify(reg.snapshot(task), null, 2) };
  },
};
