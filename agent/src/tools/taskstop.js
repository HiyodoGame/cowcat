// TaskStop tool: kill a background task and return its final output summary.
export const TaskStopTool = {
  name: 'TaskStop',
  description: `Stop a background task started by Bash with run_in_background. The task is SIGKILLed and its collected output (stdout, stderr, any partial result) is returned as a summary.`,
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The background task id' },
    },
    required: ['task_id'],
  },
  execute(input, ctx) {
    const reg = ctx.background;
    if (!reg) return { ok: false, error: 'Background tasks are not available in this context' };
    const task = reg.stop(input.task_id);
    if (!task) return { ok: false, error: `Unknown task: ${input.task_id}` };
    const snap = reg.snapshot(task);
    return { ok: true, output: `stopped ${input.task_id}\n${snap.output}` };
  },
};
