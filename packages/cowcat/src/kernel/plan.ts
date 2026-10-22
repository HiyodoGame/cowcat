import type { ToolSpec } from '../ports/index.js';

/**
 * Plan review — the kernel's own tool for leaving plan mode (ADR-125).
 *
 * `ExitPlan` is how a model in plan mode (ADR-124) presents its implementation
 * options: 1..N `{title, summary}` plans go to the person in front of the session,
 * the choice comes back as the tool result, and a chosen plan exits plan mode so
 * execution can start. Like `Task` (ADR-080) it lives here rather than in
 * `adapters/tools/` because the kernel puts it on the wire and takes the answer
 * off again — but unlike `Task` it never reaches `policy.decided`: the person's
 * plan choice IS the approval, and a second permission prompt before the card
 * would be theatre.
 */

export const EXIT_PLAN_TOOL_NAME = 'ExitPlan';
/** The most plans one call may carry; borrowed from upstream's "2~4 plans" evidence. */
export const PLAN_OPTION_MAX = 4;
export const PLAN_TITLE_MAX_CHARS = 120;
export const PLAN_SUMMARY_MAX_CHARS = 4_000;

export interface PlanOption {
  readonly title: string;
  readonly summary: string;
}

/** What the person answered. `none` carries the reason so the model can revise. */
export type PlanChoice =
  | { readonly kind: 'chosen'; readonly index: number }
  | { readonly kind: 'none'; readonly reason: string };

export const EXIT_PLAN_SPEC: ToolSpec = {
  name: EXIT_PLAN_TOOL_NAME,
  description: `Present implementation plans to the user and leave plan mode with the one they pick.

When to use: you have explored enough to know the viable approaches and the user should choose between them. Present ${String(PLAN_OPTION_MAX)} plans at most, best 2-3: each needs a short title (what it is) and a summary covering the key steps and tradeoffs. After the user picks one, plan mode turns off and you implement THAT plan — do not switch approaches afterwards unless the user says so.
When NOT to use: you are not in plan mode (the tool is not offered there), or there is only one reasonable approach and nothing to choose — just say what you will do and proceed once plan mode is off.
The user's choice (or their reason for rejecting every plan) comes back as the tool result.`,
  // The tool proposes; it executes nothing. The risk field only matters if a spec ever
  // reached `policy.decided`, and this one never does (the kernel routes it before).
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      plans: {
        type: 'array',
        minItems: 1,
        maxItems: PLAN_OPTION_MAX,
        description: `The implementation plans to choose from (1-${String(PLAN_OPTION_MAX)}, best 2-3)`,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: `Short name of the plan (at most ${String(PLAN_TITLE_MAX_CHARS)} chars)` },
            summary: { type: 'string', description: `Key steps and tradeoffs (at most ${String(PLAN_SUMMARY_MAX_CHARS)} chars)` },
          },
          required: ['title', 'summary'],
        },
      },
    },
    required: ['plans'],
  },
};

export type ExitPlanParse =
  | { readonly ok: true; readonly plans: readonly PlanOption[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate an `ExitPlan` call, in the kernel's own words. Deliberately strict about
 * shape (a plan the person cannot read is not a plan), and deliberately silent about
 * editorial quality — that is the model's job.
 */
export function parseExitPlanInput(input: unknown): ExitPlanParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'input must be an object with a plans array' };
  }
  const plans = (input as Record<string, unknown>).plans;
  if (!Array.isArray(plans) || plans.length === 0) {
    return { ok: false, reason: 'plans must be a non-empty array' };
  }
  if (plans.length > PLAN_OPTION_MAX) {
    return { ok: false, reason: `at most ${String(PLAN_OPTION_MAX)} plans, got ${String(plans.length)}` };
  }
  const parsed: PlanOption[] = [];
  for (const [index, raw] of plans.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `plan ${String(index + 1)} must be an object` };
    }
    const title = (raw as Record<string, unknown>).title;
    const summary = (raw as Record<string, unknown>).summary;
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, reason: `plan ${String(index + 1)} needs a non-empty title` };
    }
    if (title.includes('\n')) {
      // A title renders on one card row and inside 《title》 in the tool result; a
      // newline in it breaks both layouts (review of #167, P2-12).
      return { ok: false, reason: `plan ${String(index + 1)} title must be a single line` };
    }
    if (title.length > PLAN_TITLE_MAX_CHARS) {
      return { ok: false, reason: `plan ${String(index + 1)} title exceeds ${String(PLAN_TITLE_MAX_CHARS)} chars` };
    }
    if (typeof summary !== 'string' || summary.trim() === '') {
      return { ok: false, reason: `plan ${String(index + 1)} needs a non-empty summary` };
    }
    if (summary.length > PLAN_SUMMARY_MAX_CHARS) {
      return { ok: false, reason: `plan ${String(index + 1)} summary exceeds ${String(PLAN_SUMMARY_MAX_CHARS)} chars` };
    }
    parsed.push({ title, summary });
  }
  return { ok: true, plans: parsed };
}

/** The tool result the model reads after the person decides. */
export function formatPlanResult(choice: PlanChoice, plans: readonly PlanOption[]): string {
  if (choice.kind === 'none') {
    return [
      'The user rejected every plan.',
      choice.reason.trim() === '' ? 'Revise the plans and call ExitPlan again.' : `Their reason: ${choice.reason}`,
      'You are still in plan mode: read-only tools only, no writes, no commands.',
    ].join('\n');
  }
  const plan = plans[choice.index];
  if (plan === undefined) return 'The user picked a plan, but it no longer exists — call ExitPlan again.';
  return [
    `The user chose plan ${String(choice.index + 1)}: 《${plan.title}》.`,
    'Plan mode is now OFF. Implement exactly this plan:',
    '',
    plan.summary,
  ].join('\n');
}
