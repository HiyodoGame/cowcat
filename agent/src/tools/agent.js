// Agent tool: launch a sub agent with its own context; result text is returned to the caller.
export const AgentTool = {
  name: 'Agent',
  description: `Delegate a self-contained task to a sub agent that runs with its own conversation and cannot see this one. Only its final report comes back.

When to use: isolated investigation that would flood the main context — mapping where something lives, auditing a subsystem, gathering facts across many files; or an autonomous implementation slice delegated to the general role. The sub agent runs with a role-specific tool set (restricted roles are read-only), which makes it safe for open-ended exploration.
When NOT to use: work you are already in the middle of (context switching costs more than it saves), or anything where you need to see intermediate results rather than a summary.
The prompt must be self-contained: goal, relevant paths, and what the report should contain. It should end with the answer, not a narration of the search. Use subagent_type to pick a role (scout for read-only reconnaissance — the default; plan for a read-only implementation plan; general for full tool access; verify to check a change against its requirements; or a custom role from /agents). Use skill to inject one of the indexed skills (see /skills) into the sub agent. Use resume with a session JSONL path to continue a previous sub agent run. The optional model field overrides which model the sub agent uses; keep max_turns small (the default is 10) to bound the run. The effort field sets the sub agent's thinking strength (low/medium/high/xhigh/max, default high): lower efforts cap or disable extended thinking, which is faster and cheaper for shallow tasks. Unlike the reference CLI, run_in_background defaults to false (foreground) to preserve current behavior — set it true to launch the sub agent as a background task and collect the report later with TaskOutput using the returned task id.
Failure modes: a vague prompt yields a vague report — state what evidence you need (file paths, line numbers). If a verify report says FAIL, fix the issues in the main session rather than re-delegating blindly.`,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '3-5 word description of the task' },
      prompt: { type: 'string', description: 'Complete, self-contained instructions for the sub agent' },
      subagent_type: { type: 'string', description: 'Role: scout (default) | plan | general | verify | a custom role from /agents' },
      skill: { type: 'string', description: 'Name of an indexed skill (/skills) to inject into the sub agent' },
      resume: { type: 'string', description: 'Path to a sub agent session JSONL to continue from' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Run the sub agent inside a fresh git worktree (isolated checkout)' },
      model: { type: 'string', description: 'Optional model override for the sub agent' },
      max_turns: { type: 'number', description: 'Max agentic rounds for the sub agent (default 10)' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Thinking strength of the sub agent (default high)' },
      run_in_background: { type: 'boolean', description: 'Launch as a background task and return a task id immediately (retrieve the report with TaskOutput). Defaults to false — runs foreground and returns the report directly' },
    },
    required: ['description', 'prompt'],
  },
  async execute(input, ctx) {
    if (!ctx.spawnAgent) return { ok: false, error: 'Sub agents are not available in this context' };
    const effort = input.effort ?? 'high';
    const spawn = () => ctx.spawnAgent({
        description: input.description,
        prompt: input.prompt,
        model: input.model,
        maxTurns: input.max_turns ?? 10,
        subagent_type: input.subagent_type ?? null,
        skill: input.skill ?? null,
        resume: input.resume ?? null,
        isolation: input.isolation ?? null,
        effort,
      });
    if (input.run_in_background) {
      const reg = ctx.background;
      if (!reg || typeof reg.startAsync !== 'function') {
        return { ok: false, error: 'Background execution is not available in this context; rerun with run_in_background false to run foreground' };
      }
      // startAsync hands its AbortSignal to the function; TaskStop forwards it
      // into the sub agent's runLoop so a background sub agent can be cancelled.
      const task = reg.startAsync((signal) => ctx.spawnAgent({
        description: input.description,
        prompt: input.prompt,
        model: input.model,
        maxTurns: input.max_turns ?? 10,
        subagent_type: input.subagent_type ?? null,
        skill: input.skill ?? null,
        resume: input.resume ?? null,
        isolation: input.isolation ?? null,
        effort,
        signal,
      }), { description: `Agent: ${input.description || 'sub agent'}` });
      return { ok: true, output: `Sub agent started in background: ${task.id}\nRetrieve the report with TaskOutput (task_id: "${task.id}").` };
    }
    try {
      const result = await spawn();
      return { ok: true, output: result };
    } catch (e) {
      return { ok: false, error: `Sub agent failed: ${e.message}` };
    }
  },
};
