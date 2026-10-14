// CronCreate / CronDelete / CronList / ScheduleWakeup: session scheduling.
// Cron jobs are persisted to ~/.cowcat/crons.json (COWCAT_HOME overridable),
// survive restarts, and fire while the REPL is idle: the main loop checks for
// due prompts before each readLine and injects them as new user turns.
// ScheduleWakeup is a one-shot job (delaySeconds + prompt) built on the same
// store, for /loop-style self wake-ups.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cowcatHome } from '../config.js';

const FIELD_RANGES = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day-of-month', 1, 31],
  ['month', 1, 12],
  ['day-of-week', 0, 6], // 0 = Sunday; 7 also accepted as Sunday
];

const CRON_EXAMPLE = 'e.g. "*/15 * * * *" (every 15 min), "0 9 * * 1-5" (weekdays 9:00), "30 14 1 * *" (14:30 on the 1st)';

// Parse one cron field into a sorted array of allowed values.
// Supports: *  |  */n  |  a  |  a,b,c  |  a-b  |  a-b/n  |  a/n  |  any comma mix.
function parseField(text, min, max, name) {
  if (!text || !text.trim()) throw new Error(`CronCreate: empty ${name} field`);
  const values = new Set();
  let restricted = true; // false when the field is a bare "*" (always matches)
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) {
      throw new Error(`CronCreate: invalid "${part}" in ${name} field. Fields support "*", "*/n", numbers, lists (1,2), ranges (1-5) and stepped ranges (1-10/2). ${CRON_EXAMPLE}`);
    }
    if (part === '*') restricted = false;
    const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`CronCreate: step "/${m[3]}" in ${name} field must be a positive integer`);
    }
    let lo = m[1] === '*' ? min : parseInt(m[1], 10);
    let hi = m[2] !== undefined ? parseInt(m[2], 10) : (m[1] === '*' || m[3] !== undefined ? max : lo);
    if (name === 'day-of-week') { if (lo === 7) lo = 0; if (hi === 7) hi = 0; }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`CronCreate: range "${part}" in ${name} field out of bounds (${name} is ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) throw new Error(`CronCreate: "${text}" in ${name} field matches no values`);
  return { values: [...values].sort((a, b) => a - b), restricted };
}

// Parse a 5-field cron expression (minute hour day-of-month month day-of-week).
// Returns { minute, hour, dom, month, dow, domRestricted, dowRestricted }.
export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('CronCreate: cron must be a string');
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`CronCreate: cron "${expr}" must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}. ${CRON_EXAMPLE}`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => {
    const [name, min, max] = FIELD_RANGES[i];
    return parseField(f, min, max, name);
  });
  return {
    minute: minute.values, hour: hour.values,
    dom: dom.values, month: month.values, dow: dow.values,
    domRestricted: dom.restricted, dowRestricted: dow.restricted,
  };
}

// Next local fire time strictly after `from`. Day-by-day scan (max 5 years),
// so sparse schedules like "0 0 29 2 *" work; times are local.
export function nextFire(parsed, from = new Date()) {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1); // fire on minute boundaries only
  for (let d = 0; d < 366 * 5; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    if (!parsed.month.includes(day.getMonth() + 1)) continue;
    const domMatch = parsed.dom.includes(day.getDate());
    const dowMatch = parsed.dow.includes(day.getDay());
    // Standard cron rule: when BOTH day fields are restricted, either may match.
    const dayMatch = parsed.domRestricted && parsed.dowRestricted ? (domMatch || dowMatch) : (domMatch && dowMatch);
    if (!dayMatch) continue;
    for (const h of parsed.hour) {
      if (d === 0 && h < start.getHours()) continue;
      for (const m of parsed.minute) {
        if (d === 0 && h === start.getHours() && m < start.getMinutes()) continue;
        const fire = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (fire.getTime() > from.getTime()) return fire;
      }
    }
  }
  throw new Error('CronCreate: no fire time found within 5 years — is the schedule too sparse?');
}

// --- persistence ---------------------------------------------------------------

export function cronsFile() {
  return join(cowcatHome(), 'crons.json');
}

export function loadCrons() {
  const file = cronsFile();
  if (!existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return []; // corrupt JSON -> start empty rather than crash the REPL
  }
  if (!Array.isArray(data)) return [];
  return data.filter((c) => c && typeof c.id === 'string' && typeof c.nextFireAt === 'string' && typeof c.prompt === 'string');
}

export function saveCrons(list) {
  const file = cronsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2));
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

// Insert a job and persist; shared by CronCreate and ScheduleWakeup.
function addJob({ cron = null, prompt, recurring, nextFireAt, sessionId = null, cwd = null }) {
  const job = {
    id: newId(cron ? 'cron' : 'wake'),
    cron, prompt, recurring,
    nextFireAt,
    createdAt: new Date().toISOString(),
    sessionId, cwd,
  };
  const list = loadCrons();
  list.push(job);
  saveCrons(list);
  return job;
}

// Due-fire sweep used by the REPL idle hook. Returns the prompts to inject
// (wrapped with fire context); recurring jobs advance to their next fire time,
// one-shot jobs (incl. ScheduleWakeup) are removed. Mutations are persisted.
export function takeDueCrons(now = new Date()) {
  const list = loadCrons();
  const due = [];
  const keep = [];
  for (const job of list) {
    const t = Date.parse(job.nextFireAt);
    if (!Number.isNaN(t) && t <= now.getTime()) {
      due.push(job);
      if (job.recurring) {
        try {
          job.nextFireAt = nextFire(parseCron(job.cron), now).toISOString();
          keep.push(job);
        } catch { /* unparseable on recompute -> drop the job */ }
      }
      // recurring=false fires once and is removed
    } else {
      keep.push(job);
    }
  }
  if (due.length) saveCrons(keep);
  return due.map((job) => ({ id: job.id, cron: job.cron, recurring: job.recurring, prompt: cronFirePrompt(job) }));
}

// The text injected as a new user turn when a job fires.
export function cronFirePrompt(job) {
  const kind = job.recurring ? 'recurring cron' : 'one-shot wakeup';
  const sched = job.cron ? `cron="${job.cron}"` : 'one-shot';
  return `<cron-fire id="${job.id}" ${sched} kind="${kind}">\n${job.prompt}\n</cron-fire>`;
}

// --- tools ---------------------------------------------------------------------

export const CronCreateTool = {
  name: 'CronCreate',
  description: `Create a scheduled task that injects a prompt into this session when it fires.

Use this tool to schedule recurring or one-shot work: reminders, periodic checks, follow-ups. The schedule is checked while the REPL is idle; when a job fires, its prompt is injected as a new user message. Jobs persist across restarts in ~/.cowcat/crons.json.

## Cron syntax (5 fields, local time)

minute hour day-of-month month day-of-week

- "*": every value
- "*/n": every n (e.g. "*/15" = every 15 minutes)
- lists: "1,2,3"
- ranges: "9-17"
- stepped ranges: "1-10/2"
- day-of-week: 0 = Sunday (7 also accepted as Sunday)

## Examples

- "*/15 * * * *" — every 15 minutes
- "0 9 * * 1-5" — weekdays at 9:00
- "30 14 1 * *" — 14:30 on the 1st of every month

Returns the job id and nextFireAt (ISO timestamp). Non-recurring jobs are deleted after they fire once.`,
  input_schema: {
    type: 'object',
    properties: {
      cron: { type: 'string', description: '5-field cron expression (minute hour day-of-month month day-of-week), local time' },
      prompt: { type: 'string', description: 'The prompt text injected as a user message when the task fires' },
      recurring: { type: 'boolean', description: 'Repeat on schedule (default true). false = fire once and delete.' },
    },
    required: ['cron', 'prompt'],
  },
  execute(input, ctx) {
    try {
      const parsed = parseCron(input.cron);
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return { ok: false, error: 'CronCreate: prompt must be a non-empty string' };
      }
      const recurring = input.recurring !== false;
      const nextFireAt = nextFire(parsed).toISOString();
      const job = addJob({
        cron: input.cron.trim(),
        prompt: input.prompt,
        recurring,
        nextFireAt,
        sessionId: ctx.sessionId ?? null,
        cwd: ctx.cwd ?? null,
      });
      return {
        ok: true,
        output: JSON.stringify({
          id: job.id, cron: job.cron, recurring,
          nextFireAt, createdAt: job.createdAt,
        }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

export const CronDeleteTool = {
  name: 'CronDelete',
  description: `Delete a scheduled task by id.

Use this tool to cancel a cron job or scheduled wakeup created with CronCreate / ScheduleWakeup. Returns an error if the id is unknown. Use CronList to see ids.`,
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the scheduled task to delete (from CronCreate / CronList)' },
    },
    required: ['id'],
  },
  execute(input) {
    const list = loadCrons();
    const idx = list.findIndex((c) => c.id === input.id);
    if (idx === -1) return { ok: false, error: `Unknown scheduled task: ${input.id}` };
    const [removed] = list.splice(idx, 1);
    saveCrons(list);
    return { ok: true, output: JSON.stringify({ deleted: removed.id, cron: removed.cron ?? null }, null, 2) };
  },
};

export const CronListTool = {
  name: 'CronList',
  description: `List all scheduled tasks (cron jobs and wakeups).

Returns id, cron expression, next fire time, prompt summary, and whether each task repeats. Empty input lists everything.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
  execute() {
    const list = loadCrons().map((c) => ({
      id: c.id,
      cron: c.cron ?? null, // null = one-shot wakeup (ScheduleWakeup)
      nextFireAt: c.nextFireAt,
      recurring: !!c.recurring,
      prompt: c.prompt.length > 120 ? `${c.prompt.slice(0, 120)}…` : c.prompt,
      sessionId: c.sessionId ?? null,
    }));
    return { ok: true, output: JSON.stringify({ tasks: list, count: list.length }, null, 2) };
  },
};

export const ScheduleWakeupTool = {
  name: 'ScheduleWakeup',
  description: `Request that this session wake itself up with a prompt after a delay.

Use this tool when you are waiting on something (a long build, a timer, an external condition) and want the session to automatically resume work later — the classic /loop pattern. The wakeup fires while the REPL is idle: your prompt is injected as a new user message. This is a one-shot timer implemented as a non-recurring scheduled task.

Either delaySeconds (e.g. 300 = 5 minutes) or delayMs may be given; delaySeconds wins if both are present. Maximum 24 hours.`,
  input_schema: {
    type: 'object',
    properties: {
      delaySeconds: { type: 'number', description: 'Seconds from now until the wakeup fires (e.g. 300)' },
      delayMs: { type: 'number', description: 'Milliseconds from now until the wakeup fires (alternative to delaySeconds)' },
      prompt: { type: 'string', description: 'The prompt injected as a user message when the wakeup fires — make it self-contained' },
      reason: { type: 'string', description: 'Optional short note explaining why the wakeup is scheduled (shown in CronList via the prompt)' },
    },
    required: ['prompt'],
  },
  execute(input, ctx) {
    let delayMs;
    if (typeof input.delaySeconds === 'number') delayMs = input.delaySeconds * 1000;
    else if (typeof input.delayMs === 'number') delayMs = input.delayMs;
    else return { ok: false, error: 'ScheduleWakeup: provide delaySeconds or delayMs (number)' };
    if (!Number.isFinite(delayMs) || delayMs < 0) return { ok: false, error: 'ScheduleWakeup: delay must be a non-negative number' };
    if (delayMs > 24 * 3600 * 1000) return { ok: false, error: 'ScheduleWakeup: delay exceeds the 24h maximum' };
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      return { ok: false, error: 'ScheduleWakeup: prompt must be a non-empty string' };
    }
    const prompt = input.reason?.trim() ? `[${input.reason.trim()}]\n${input.prompt}` : input.prompt;
    const job = addJob({
      prompt, recurring: false,
      nextFireAt: new Date(Date.now() + delayMs).toISOString(),
      sessionId: ctx.sessionId ?? null, cwd: ctx.cwd ?? null,
    });
    return {
      ok: true,
      output: JSON.stringify({
        id: job.id, recurring: false,
        wakeAt: job.nextFireAt, delayMs,
      }, null, 2),
    };
  },
};
