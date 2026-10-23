import { z } from 'zod';
import { parseSchedule } from '../../policy/cron.js';
import type { CronTasksPort, ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

// The three cron tools (ADR-143 ①). They are thin on purpose: validation lives in
// policy/cron (the dialect) and in the host's CronTasksPort (the cap, the identity),
// so the tool itself only translates between the wire shape and the port, then reports.
// What makes a call real is the event the kernel writes from the ToolResult extension —
// same division of labour the Bash/background pair already has (ADR-110/111).

const CREATE_DESCRIPTION = [
  'Schedule a prompt to run automatically in this session, on a cron schedule.',
  '',
  '`schedule` is a 5-field cron expression in LOCAL time: minute hour day-of-month month day-of-week.',
  'Supported: `*` (every), `*/n` (steps), single values, ranges (`1-5`), comma lists. `0` and `7` are both Sunday.',
  'NOT supported: names (MON), L, W, ? — such schedules are refused with the reason.',
  '',
  'The scheduled turn runs while the user is away: it CANNOT ask approvals, escalate, or enter plan review.',
  'Write operations it needs must already be allowed by the session rules, or the turn reports what it needed instead.',
  '',
  'Recurring jobs expire 7 days after creation (they fire one final time, then delete themselves).',
  'A session holds at most 50 live jobs.',
  '',
  'When to use: polling a deploy, babysitting a PR, checking a build on an interval, or a one-shot reminder ("in 45 minutes check the tests" = schedule the next matching minute with recurring: false).',
  'When NOT to use: work the current turn can just do, or anything that needs the user to approve actions along the way.',
].join('\n');

const LIST_DESCRIPTION = [
  'List this session\'s scheduled jobs: id, schedule, prompt, and next scheduled run.',
  'Use before CronDelete to pick the right id, and to answer "what is this session still running?".',
].join('\n');

const DELETE_DESCRIPTION = [
  'Delete one of this session\'s scheduled jobs by id (from CronList).',
  'Returns an error when the id is not a live job of this session.',
].join('\n');

export interface CronToolsOptions {
  /** The host's job table. `undefined` means this build does not offer cron — the
   * factory returns no tools, so the model cannot call what does not exist. */
  readonly cron: CronTasksPort | undefined;
}

/** The three tools as one factory so the host adds none or all of them (ADR-143 ④). */
export function createCronTools(options: CronToolsOptions): readonly ToolPort[] {
  const cron = options.cron;
  if (cron === undefined) return [];

  return [
    defineTool(
      {
        name: 'CronCreate',
        description: CREATE_DESCRIPTION,
        // Scheduling unattended model spend is a mutation of the session's behaviour —
        // the default no-rule-matched verdict (ask) is the right gate, and in an
        // unattended turn it refuses, exactly like any other ask (ADR-142).
        risk: 'write',
        input: z.object({
          schedule: z.string().min(1).describe('5-field cron expression, local time, e.g. "*/5 * * * *"'),
          prompt: z.string().min(1).describe('The prompt the scheduled turn will run'),
          recurring: z.boolean().describe('true = repeat on the schedule until it expires; false = fire once'),
        }),
      },
      async (input, _signal, _grant, context) => {
        if (context === undefined) {
          return { ok: false, output: 'cron tools need a host context: the command was not run.' };
        }
        const parsed = parseSchedule(input.schedule);
        if (!parsed.ok) {
          return { ok: false, output: `refused: ${parsed.error}` };
        }
        const outcome = await cron.create(context.sessionId, {
          schedule: input.schedule.trim(),
          prompt: input.prompt,
          recurring: input.recurring,
        });
        if (!outcome.ok) {
          return { ok: false, output: `refused: ${outcome.error}` };
        }
        const next = outcome.nextRun === null ? 'never (no fire in the searchable horizon)' : new Date(outcome.nextRun).toString();
        return {
          ok: true,
          output: [
            `scheduled job ${outcome.job.jobId}`,
            `schedule: ${outcome.job.schedule} (${outcome.job.recurring ? 'recurring, expires 7 days after creation' : 'one-shot'})`,
            `next scheduled run: ${next}`,
            '',
            'The turn will run unattended: it cannot ask approvals. Anything it cannot do under the session rules, it will report instead.',
          ].join('\n'),
          cronCreated: outcome.job,
        };
      },
    ),
    defineTool(
      {
        name: 'CronList',
        description: LIST_DESCRIPTION,
        risk: 'read',
        input: z.object({}),
      },
      async (_input, _signal, _grant, context) => {
        if (context === undefined) {
          return { ok: false, output: 'cron tools need a host context: the command was not run.' };
        }
        const jobs = await cron.list(context.sessionId);
        if (jobs.length === 0) {
          return { ok: true, output: 'No scheduled jobs in this session.' };
        }
        const lines = jobs.map((job) => {
          const next = job.nextRun === null ? 'never' : new Date(job.nextRun).toString();
          const last = job.lastFiredAt === null ? 'never' : new Date(job.lastFiredAt).toString();
          return [
            `- ${job.jobId}: "${job.schedule}" (${job.recurring ? 'recurring' : 'one-shot'})`,
            `  prompt: ${job.prompt}`,
            `  next: ${next} · last fired: ${last}`,
          ].join('\n');
        });
        return { ok: true, output: lines.join('\n\n') };
      },
    ),
    defineTool(
      {
        name: 'CronDelete',
        description: DELETE_DESCRIPTION,
        risk: 'write',
        input: z.object({ jobId: z.string().min(1).describe('Job id from CronList') }),
      },
      async (input, _signal, _grant, context) => {
        if (context === undefined) {
          return { ok: false, output: 'cron tools need a host context: the command was not run.' };
        }
        const removed = await cron.remove(context.sessionId, input.jobId);
        if (!removed) {
          return { ok: false, output: `no live job "${input.jobId}" in this session. List jobs with CronList first.` };
        }
        return {
          ok: true,
          output: `deleted job ${input.jobId}`,
          cronDeleted: { jobId: input.jobId, deletedAt: Date.now() },
        };
      },
    ),
  ];
}
