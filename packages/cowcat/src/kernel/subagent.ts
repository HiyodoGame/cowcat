import type { SubagentOutcome, SubagentRole, ToolSpec, Truncation } from '../ports/index.js';

/**
 * The one tool name the kernel answers itself (ADR-080).
 *
 * `Task` rather than `Agent`: upstream renamed its tool because that one now also
 * covers background sessions and teams, and this one does not. Keeping the narrower
 * name leaves `Agent` free for the orchestration layer (R5) instead of promising it
 * early.
 */
export const TASK_TOOL_NAME = 'Task';

/** Rounds a child gets when the caller does not say (ADR-082 ②). */
export const DEFAULT_SUBAGENT_MAX_TURNS = 10;
/** The hard ceiling on `max_turns`, so one call cannot ask for an unbounded run. */
export const MAX_SUBAGENT_MAX_TURNS = 20;
/** What a report may add to the parent's context before it is clipped (ADR-082 ②). */
export const SUBAGENT_REPORT_MAX_CHARS = 20_000;
/** Long enough for "3-5 words", short enough to stay useful as a card title. */
const DESCRIPTION_MAX_CHARS = 200;

/**
 * The spec the model sees. It is declared here, not in `adapters/tools/`, because the
 * kernel has to put it on the wire and take it off again (ADR-080 ②).
 *
 * The description is model-facing and therefore carries the two things a delegation
 * prompt must know: when it is worth the isolation, and that the child cannot ask
 * anything (ADR-081 ③) — a child that silently gets refusals is a surprise nobody
 * should have to discover by reading its log afterwards.
 */
export const TASK_SPEC: ToolSpec = {
  name: TASK_TOOL_NAME,
  description: `Delegate a self-contained task to a sub agent that runs in its own context and cannot see this conversation. Only its final report comes back.

When to use: isolated investigation that would flood this context — mapping where something lives, auditing a subsystem, gathering facts across many files — or a bounded implementation slice handed to the general role. The child starts fresh, so the prompt must be self-contained: the goal, the relevant paths, and what the report must contain.
When NOT to use: work you are already in the middle of (context switching costs more than it saves), or anything where you need the intermediate steps rather than a summary.
Roles: \`explore\` (default) is read-only (Read, Glob, Grep). \`general\` also has the parent's other tools, but cannot delegate further. Sub agents cannot ask a human: a permission prompt inside one is refused, and the refusal comes back as the tool result.
The report is capped at ${String(SUBAGENT_REPORT_MAX_CHARS)} characters; the full transcript stays in the child session, whose id comes back with every report.`,
  risk: 'exec',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '3-5 words describing the task, for the transcript' },
      prompt: { type: 'string', description: 'Complete, self-contained instructions for the sub agent' },
      agent: {
        type: 'string',
        enum: ['explore', 'general'],
        description: 'explore (default) is read-only; general also has the parent\'s tools',
      },
      max_turns: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_SUBAGENT_MAX_TURNS,
        description: `Maximum agentic rounds for the sub agent (default ${String(DEFAULT_SUBAGENT_MAX_TURNS)})`,
      },
    },
    required: ['description', 'prompt'],
  },
};

/** The validated call, in the kernel's own words rather than the model's. */
export interface TaskInput {
  readonly description: string;
  readonly prompt: string;
  readonly role: SubagentRole;
  readonly maxTurns: number;
}

export type TaskParse = { readonly ok: true; readonly input: TaskInput } | { readonly ok: false; readonly reason: string };

/**
 * Validate a `Task` call.
 *
 * The kernel does this itself rather than through `defineTool()`'s zod path because the
 * tool never reaches an adapter: a bad call has to become a tool result the model can
 * read, not an exception that fails the turn. Refusals name the limit — "too long" with
 * no number teaches the model nothing.
 */
export function parseTaskInput(raw: unknown): TaskParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'input must be an object' };
  const record = raw as Record<string, unknown>;

  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (description === '') return { ok: false, reason: 'description is required' };
  if (description.length > DESCRIPTION_MAX_CHARS) {
    return { ok: false, reason: `description is over ${String(DESCRIPTION_MAX_CHARS)} characters` };
  }

  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (prompt === '') return { ok: false, reason: 'prompt is required, and must be self-contained' };

  const role = record.agent ?? 'explore';
  if (role !== 'explore' && role !== 'general') {
    return { ok: false, reason: "agent must be 'explore' or 'general'" };
  }

  const maxTurns = record.max_turns ?? DEFAULT_SUBAGENT_MAX_TURNS;
  if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_SUBAGENT_MAX_TURNS) {
    return { ok: false, reason: `max_turns must be an integer from 1 to ${String(MAX_SUBAGENT_MAX_TURNS)}` };
  }

  return { ok: true, input: { description, prompt, role, maxTurns } };
}

/**
 * Bound what the delegation adds to the parent's context (ADR-082 ②).
 *
 * The marker is appended after the cap and is not counted in `dropped`: `dropped` answers
 * "how much of the report is missing", which is the question an audit asks, and the
 * marker is our own text rather than the child's.
 */
export function clipReport(report: string): { readonly text: string; readonly truncation: Truncation | null } {
  if (report.length <= SUBAGENT_REPORT_MAX_CHARS) return { text: report, truncation: null };
  return {
    text: `${report.slice(0, SUBAGENT_REPORT_MAX_CHARS)}\n\n[… report truncated to fit the delegation budget]`,
    truncation: {
      truncated: true,
      dropped: report.length - SUBAGENT_REPORT_MAX_CHARS,
      reason: `subagent report: ${String(SUBAGENT_REPORT_MAX_CHARS)} characters`,
    },
  };
}

/**
 * What the parent model reads.
 *
 * The session id is always present, successful or not: it is the one handle that makes
 * the child's full transcript reachable, and upstream's version of this pattern exists
 * precisely because passing a whole conversation through a coordinator loses fidelity.
 */
export function formatTaskResult(outcome: SubagentOutcome, text: string): string {
  const rounds = `${String(outcome.turns)} ${outcome.turns === 1 ? 'round' : 'rounds'}`;
  const partial = outcome.partial ? ', stopped at max_turns' : '';
  const header =
    outcome.state === 'completed'
      ? `Sub agent (${outcome.role}, session ${outcome.sessionId}, ${rounds}${partial}) reported:`
      : `Sub agent (${outcome.role}, session ${outcome.sessionId}, ${outcome.state}, ${rounds}${partial}) did not finish: ${outcome.reason ?? 'no reason given'}`;
  return `${header}\n\n${text}`;
}
