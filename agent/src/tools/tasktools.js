// TaskCreate/TaskGet/TaskUpdate/TaskList tools: structured task tracking on the
// session ctx (independent of the Bash background-task system). Unlike
// TodoWrite's single active list, many tasks can be pending/in_progress at once.
const VALID_STATUS = ['pending', 'in_progress', 'completed', 'failed'];
const ALL_STATUS = [...VALID_STATUS, 'deleted'];

function ensureTasks(ctx) {
  if (!Array.isArray(ctx.state.tasks)) ctx.state.tasks = [];
  return ctx.state.tasks;
}

function nextId(ctx) {
  ctx.state.taskSeq = (ctx.state.taskSeq || 0) + 1;
  return String(ctx.state.taskSeq);
}

function findTask(ctx, taskId) {
  return ensureTasks(ctx).find((t) => t.id === String(taskId));
}

function summary(t) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    owner: t.owner ?? null,
    activeForm: t.activeForm ?? '',
    blocks: [...t.blocks],
    blockedBy: [...t.blockedBy],
  };
}

export const TaskCreateTool = {
  name: 'TaskCreate',
  description: `Create a new task in the task list.

Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm**: Present continuous form shown in spinner when task is in_progress (e.g., "Fixing authentication bug"). This is displayed to the user while you work on the task.

**IMPORTANT**: Always provide activeForm when creating tasks. The subject should be imperative ("Run tests") while activeForm should be present continuous ("Running tests"). All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks`,
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")' },
      description: { type: 'string', description: 'Detailed description of what needs to be done, including context and acceptance criteria' },
      activeForm: { type: 'string', description: 'Present continuous form shown in spinner when task is in_progress (e.g., "Fixing authentication bug")' },
    },
    required: ['subject'],
  },
  execute(input, ctx) {
    const tasks = ensureTasks(ctx);
    const task = {
      id: nextId(ctx),
      subject: input.subject,
      description: input.description ?? '',
      activeForm: input.activeForm ?? '',
      status: 'pending',
      owner: null,
      blocks: [],
      blockedBy: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.push(task);
    return { ok: true, output: JSON.stringify({ taskId: task.id, task: summary(task) }, null, 2) };
  },
};

export const TaskGetTool = {
  name: 'TaskGet',
  description: `Get a task by ID from the task list.

Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The ID of the task to retrieve' },
    },
    required: ['taskId'],
  },
  execute(input, ctx) {
    const task = findTask(ctx, input.taskId);
    if (!task) return { ok: false, error: `Unknown task: ${input.taskId}` };
    return { ok: true, output: JSON.stringify(task, null, 2) };
  },
};

export const TaskUpdateTool = {
  name: 'TaskUpdate',
  description: `Update a task in the task list.

Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The ID of the task to update' },
      status: { type: 'string', enum: ALL_STATUS, description: 'New status: pending, in_progress, completed, failed (deleted permanently removes the task)' },
      subject: { type: 'string', description: 'Change the task title (imperative form)' },
      description: { type: 'string', description: 'Change the task description' },
      activeForm: { type: 'string', description: 'Present continuous form shown when in_progress' },
      owner: { type: 'string', description: 'Change the task owner (agent name)' },
      metadata: { type: 'object', description: 'Merge metadata keys into the task (set a key to null to delete it)' },
      addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs that cannot start until this one completes' },
      addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this one can start' },
    },
    required: ['taskId'],
  },
  execute(input, ctx) {
    const tasks = ensureTasks(ctx);
    const task = tasks.find((t) => t.id === String(input.taskId));
    if (!task) return { ok: false, error: `Unknown task: ${input.taskId}` };
    if (input.status !== undefined && !ALL_STATUS.includes(input.status)) {
      return { ok: false, error: `Invalid status "${input.status}"` };
    }
    if (input.status === 'deleted') {
      const idx = tasks.indexOf(task);
      tasks.splice(idx, 1);
      return { ok: true, output: `Task ${task.id} deleted` };
    }
    const link = (field, ids) => {
      for (const id of ids || []) {
        const other = tasks.find((t) => t.id === String(id));
        if (!other) return `Unknown task: ${id}`;
        if (other.id === task.id) return 'A task cannot depend on itself';
        if (!task[field].includes(other.id)) task[field].push(other.id);
        const mirror = field === 'blocks' ? 'blockedBy' : 'blocks';
        if (!other[mirror].includes(task.id)) other[mirror].push(task.id);
      }
      return null;
    };
    const err = link('blocks', input.addBlocks) || link('blockedBy', input.addBlockedBy);
    if (err) return { ok: false, error: err };
    if (input.status !== undefined) task.status = input.status;
    for (const k of ['subject', 'description', 'activeForm', 'owner']) {
      if (input[k] !== undefined) task[k] = input[k];
    }
    if (input.metadata && typeof input.metadata === 'object') {
      for (const [k, v] of Object.entries(input.metadata)) {
        if (v === null) delete task.metadata[k];
        else task.metadata[k] = v;
      }
    }
    task.updatedAt = new Date().toISOString();
    return { ok: true, output: JSON.stringify({ taskId: task.id, task: summary(task) }, null, 2) };
  },
};

export const TaskListTool = {
  name: 'TaskList',
  description: `List all tasks in the task list.

Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description.`,
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: VALID_STATUS, description: 'Only return tasks with this status' },
    },
  },
  execute(input, ctx) {
    let tasks = ensureTasks(ctx);
    if (input.status !== undefined) {
      if (!VALID_STATUS.includes(input.status)) return { ok: false, error: `Invalid status "${input.status}"` };
      tasks = tasks.filter((t) => t.status === input.status);
    }
    return { ok: true, output: JSON.stringify({ tasks: tasks.map(summary) }, null, 2) };
  },
};
