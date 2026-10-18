import { z } from 'zod';
import type { ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

/** The legacy bounds, kept: one concrete action per item, at most 50 of them. */
export const TODO_MIN_ITEMS = 1;
export const TODO_MAX_ITEMS = 50;

const DESCRIPTION = [
  'Replace the whole todo list for this session — the list you send is the complete new state, not a delta. Always include every existing item plus your updates.',
  '',
  'When to use: any task with three or more distinct steps, any time the user hands you a list, and whenever the shape of the work becomes clear. Mark a task in_progress before starting it and completed the moment it is done; keep exactly one item in progress. Add newly discovered steps, drop ones that turn out unnecessary (and say why in your reply if the user might wonder).',
  'When NOT to use: single-step or purely conversational requests — ceremony without benefit. Also do not use it as a scratchpad for thoughts; each item is one concrete, finishable action.',
  'Every item needs content (imperative: "Add input validation") and activeForm (present continuous: "Adding input validation") describing the same task.',
  'Failure modes: a stale list is worse than none — if your last update no longer reflects reality, fix it in your next call, immediately.',
].join('\n');

/**
 * TodoWrite holds no state (ADR-054): it validates the list and hands it back through
 * `ToolResult.todos`, and the kernel turns that into the `todo.updated` event. Which is
 * why there is nothing to read here — the tool cannot tell you the current list, and
 * that is deliberate: the model's own message history is the only place it needs.
 */
export function createTodoWriteTool(): ToolPort {
  return defineTool(
    {
      name: 'TodoWrite',
      description: DESCRIPTION,
      risk: 'write',
      input: z.object({
        todos: z
          .array(
            z.object({
              content: z.string().min(1).describe('Imperative task description, e.g. "Add input validation"'),
              status: z.enum(['pending', 'in_progress', 'completed']),
              activeForm: z.string().min(1).describe('Present-continuous form, e.g. "Adding input validation"'),
            }),
          )
          .min(TODO_MIN_ITEMS)
          .max(TODO_MAX_ITEMS)
          .describe('The complete new list'),
      }),
    },
    (input) => {
      const completed = input.todos.filter((todo) => todo.status === 'completed').length;
      return {
        ok: true,
        // No "was N items": the tool has no access to the previous list, and inventing
        // one by reading session state is exactly what ADR-054 forbids.
        output: `todo list updated (${String(completed)}/${String(input.todos.length)} completed)`,
        todos: input.todos,
        truncation: { truncated: false, dropped: 0, reason: null },
      };
    },
  );
}
