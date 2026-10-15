// TodoWrite tool: full-list replacement, persisted under ~/.cowcat/todos/<session>.json
// (legacy ~/.ccagent/todos is read for compatibility; new writes go to ~/.cowcat).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cowcatHome, resolveStateFile } from '../config.js';

const VALID_STATUS = ['pending', 'in_progress', 'completed'];

export function todoFileFor(sessionId, { forWrite = false } = {}) {
  const rel = join('todos', `${sessionId}.json`);
  return forWrite ? join(cowcatHome(), rel) : resolveStateFile(rel);
}

export function loadTodos(sessionId) {
  const f = todoFileFor(sessionId);
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return []; }
}

export function persistTodos(sessionId, todos) {
  const f = todoFileFor(sessionId, { forWrite: true });
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(todos, null, 2));
}

export const TodoWriteTool = {
  name: 'TodoWrite',
  description: `Replace the whole todo list for this session — the list you send is the complete new state, not a delta. Always include every existing item plus your updates.

When to use: any task with three or more distinct steps, any time the user hands you a list, and whenever the shape of the work becomes clear. Mark a task in_progress before starting it and completed the moment it is done; keep exactly one item in progress. Add newly discovered steps, drop ones that turn out unnecessary (and say why in your reply if the user might wonder).
When NOT to use: single-step or purely conversational requests — ceremony without benefit. Also do not use it as a scratchpad for thoughts; each item is one concrete, finishable action.
Every item needs content (imperative: "Add input validation") and activeForm (present continuous: "Adding input validation") describing the same task.
Failure modes: a stale list is worse than none — if your last update no longer reflects reality, fix it in your next call, immediately.`,
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative task description, e.g. "Add input validation"' },
            status: { type: 'string', enum: VALID_STATUS },
            activeForm: { type: 'string', description: 'Present-continuous form, e.g. "Adding input validation"' },
          },
          required: ['content', 'status', 'activeForm'],
        },
      },
    },
    required: ['todos'],
  },
  execute(input, ctx) {
    for (const t of input.todos) {
      if (!VALID_STATUS.includes(t.status)) return { ok: false, error: `Invalid status "${t.status}"` };
    }
    const old = ctx.state.todos || [];
    ctx.state.todos = input.todos;
    persistTodos(ctx.sessionId, input.todos);
    ctx.ui?.showTodos?.(input.todos);
    return {
      ok: true,
      output: `Todo list updated (${input.todos.filter((t) => t.status === 'completed').length}/${input.todos.length} completed, was ${old.length} items)`,
    };
  },
};
