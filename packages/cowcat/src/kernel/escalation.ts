import type { ToolSpec } from '../ports/index.js';

/**
 * The Escalate appeal tool (ADR-129). Offered on the wire of top-level turns only —
 * like `Task` and `ExitPlan`, a child session's deps omit it and a stray call reads
 * as an unknown tool.
 *
 * There is deliberately NO separate escalation event pair for the question: the appeal
 * rides `approval.requested` (rule: 'escalation', reason: the model's justification)
 * and the answer rides `approval.answered`, so every frontend that already renders an
 * approval card shows an appeal with zero new UI. What is new is only what the answer
 * MEANS: `escalation.granted` records the widened right, `escalation.consumed` burns
 * a `once` grant on its single retry.
 */

/**
 * Turn-scoped memory for Escalate appeals (ADR-129/130). Not log facts: they police
 * the live turn (how many appeals reached the user; which exact subjects the sandbox
 * refused here), and a replayed turn does not re-ask anyone.
 */
export interface EscalationTurnContext {
  asked: number;
  readonly sandboxRefusedKeys: Set<string>;
}

export const ESCALATE_TOOL_NAME = 'Escalate';

export const ESCALATE_SPEC: ToolSpec = {
  name: ESCALATE_TOOL_NAME,
  description: [
    'Appeal a refusal: ask the user to let ONE exact action through, with a reason.',
    '',
    'When to use: you called a tool and it was denied by a rule (the result says',
    '"denied by ..."), and the task genuinely needs that exact action. Escalate does',
    'NOT run anything itself — it asks. If the user approves, retry the original call',
    'unchanged; a "once" approval covers exactly one retry, an "always" approval covers',
    'this exact action for the rest of the session. If the appeal is rejected, do not',
    'ask again for the same action — find another way.',
    '',
    'When NOT to use: the tool was never actually denied; you have not tried the normal',
    'call yet; or a plain error (exit code, missing file) is not a policy refusal.',
  ].join('\n'),
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The tool that was denied, e.g. "Bash".' },
      command: { type: 'string', description: 'The exact command that was denied (for Bash).' },
      path: { type: 'string', description: 'The exact file path that was denied (for file tools).' },
      justification: { type: 'string', description: 'Why this action is needed. Shown to the user.' },
      withoutSandbox: {
        type: 'boolean',
        description: 'True only when the tool result said the sandbox refused this command and you need it to run without the sandbox this once.',
      },
    },
    required: ['name', 'justification'],
  },
};

export const ESCALATE_JUSTIFICATION_MAX = 500;

/** How many Escalate appeals may reach the user in one turn (review P2-1). */
export const ESCALATE_PER_TURN_LIMIT = 3;

export interface EscalateInput {
  readonly name: string;
  readonly command: string | null;
  readonly path: string | null;
  readonly justification: string;
  readonly withoutSandbox: boolean;
}

export type EscalateInputError =
  | { readonly ok: false; readonly reason: 'shape' | 'subject' | 'justification'; readonly message: string }
  | { readonly ok: true; readonly value: EscalateInput };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an Escalate call. The subject must name exactly one action (command or
 * path, not both, not neither) and must not be the bare `*` or contain a NUL — both
 * are key-collision material (ADR-129 ①). Justification is the only text a user reads
 * before deciding, so an empty one is refused rather than shown.
 */
export function parseEscalateInput(input: unknown): EscalateInputError {
  if (!isRecord(input)) {
    return { ok: false, reason: 'shape', message: 'Escalate input must be an object' };
  }
  const { name, command, path, justification, withoutSandbox } = input;
  if (typeof name !== 'string' || name === '') {
    return { ok: false, reason: 'shape', message: 'Escalate requires the denied tool name' };
  }
  if ((typeof command !== 'string' || command === '') && (typeof path !== 'string' || path === '')) {
    return { ok: false, reason: 'subject', message: 'Escalate needs the exact denied command or path' };
  }
  if (typeof command === 'string' && typeof path === 'string' && command !== '' && path !== '') {
    return { ok: false, reason: 'subject', message: 'Escalate takes a command OR a path, not both' };
  }
  const subject = typeof command === 'string' && command !== '' ? command : (path as string);
  if (subject === '*' || subject.includes('\u0000')) {
    return { ok: false, reason: 'subject', message: 'that subject cannot be escalated' };
  }
  if (typeof justification !== 'string' || justification.trim() === '') {
    return { ok: false, reason: 'justification', message: 'Escalate needs a justification the user can read' };
  }
  if (justification.length > ESCALATE_JUSTIFICATION_MAX) {
    return {
      ok: false,
      reason: 'justification',
      message: `justification is ${String(justification.length)} characters; at most ${String(ESCALATE_JUSTIFICATION_MAX)}`,
    };
  }
  return {
    ok: true,
    value: {
      name,
      command: typeof command === 'string' && command !== '' ? command : null,
      path: typeof path === 'string' && path !== '' ? path : null,
      justification,
      withoutSandbox: withoutSandbox === true,
    },
  };
}
