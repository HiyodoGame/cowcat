// Cron schedule parsing and due math (ADR-140~141).
//
// Pure by construction: it never touches the clock (the caller passes `now` in
// milliseconds) and never names a timezone (matching is done through the local-time
// fields of `Date`, so `0 9 * * *` means 9am wherever the host runs — the same
// statement the upstream docs make). The dialect is deliberately the narrow vixie
// subset: 5 fields, `*`, `*/n`, single values, ranges, and comma lists. Extended
// syntax (`L`/`W`/`?`/name aliases) is refused with a reason instead of being
// half-understood — a schedule that silently means nothing is worse than one the
// model is asked to rewrite.
//
// The projection (which jobs exist, which are due) is the host's fold over the log;
// what lives here is only the math that fold needs: parse once, answer "when is this
// schedule's next fire after T" and "is it due at N".

/** A parsed field: either unrestricted (`*`) or a set of matching numbers. */
export interface CronField {
  /** The field was `*` — it matches everything and takes part in no OR. */
  readonly any: boolean;
  readonly values: ReadonlySet<number>;
}

export interface CronSpec {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dom: CronField;
  readonly month: CronField;
  readonly dow: CronField;
  /**
   * True only for the every-5-minutes schedule (minute step 5, every other field `*`;
   * ADR-141 ⑥): the 5-minute step sits exactly on the 5-minute prompt-cache TTL, so a
   * due check may fire this schedule 15 seconds early to keep the cache warm. Any
   * other schedule fires on time.
   */
  readonly fiveMinuteStep: boolean;
}

export type ParsedSchedule = { readonly ok: true; readonly spec: CronSpec } | { readonly ok: false; readonly error: string };

/** Per-session cap on live jobs, same number as the upstream tool set (ADR-141 ③). */
export const CRON_MAX_JOBS = 50;

/** A recurring job expires this long after creation; it fires one final time and is
 * deleted `by: 'expiry'` (ADR-141 ⑤). One-shot jobs carry `expiresAt: null`. */
export const CRON_RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How far ahead of its scheduled minute a five-minute-step job counts as due (ADR-141 ⑥). */
export const DUE_AHEAD_MS = 15_000;

const FIELD_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }, // 7 is Sunday, same as 0
] as const;

// `Feb 30`-class schedules have no fire within any horizon; bound the search instead
// of looping forever. 5 years covers Feb 29 from any starting point, plus slack.
const SEARCH_LIMIT_DAYS = 366 * 5 + 2;

export function parseSchedule(expression: string): ParsedSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${String(fields.length)}` };
  }
  const parsed: CronField[] = [];
  for (let i = 0; i < 5; i++) {
    const bound = FIELD_BOUNDS[i];
    const text = fields[i];
    // The length check above makes both unreachable; the guards are for the type
    // checker, which does not track array lengths.
    if (bound === undefined || text === undefined) return { ok: false, error: 'internal: field count mismatch' };
    const field = parseField(text, bound.min, bound.max, bound.name);
    if ('error' in field) return { ok: false, error: field.error };
    parsed.push(field);
  }
  const [minute, hour, dom, month, dowRaw] = parsed;
  if (minute === undefined || hour === undefined || dom === undefined || month === undefined || dowRaw === undefined) {
    return { ok: false, error: 'internal: field parsing lost a field' };
  }
  // DOW 7 → 0, after validation so `0-7` ranges still make sense while parsing.
  const dow = normalizeSunday(dowRaw);
  return {
    ok: true,
    spec: {
      minute,
      hour,
      dom,
      month,
      dow,
      fiveMinuteStep:
        !minute.any && minute.values.size === 12 && everyTwelveIsFive(minute) &&
        hour.any && dom.any && month.any && dow.any,
    },
  };
}

function everyTwelveIsFive(minute: CronField): boolean {
  // `*/5` over 0-59 yields exactly {0,5,10,...,55}. A hand-written list with the same
  // members is the same schedule and earns the same cache treatment.
  for (let m = 0; m < 60; m += 5) {
    if (!minute.values.has(m)) return false;
  }
  return true;
}

function normalizeSunday(field: CronField): CronField {
  if (field.any || !field.values.has(7)) return field;
  const values = new Set(field.values);
  values.delete(7);
  values.add(0);
  return { any: false, values };
}

type FieldResult = { readonly any: boolean; readonly values: ReadonlySet<number> } | { readonly error: string };

function parseField(text: string, min: number, max: number, name: string): FieldResult {
  if (text === '') return { error: `${name}: empty field` };
  // Letters mean the extended syntax (name aliases, L/W) or garbage; both are refused
  // at the door rather than guessed at.
  if (/[A-Za-z?]/.test(text)) {
    return { error: `${name}: '${text}' uses unsupported syntax (name aliases, L, W and ? are not supported)` };
  }
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    const atom = parseAtom(part, min, max, name);
    if ('error' in atom) return atom;
    if (atom.whole) {
      any = true;
      continue;
    }
    for (const v of atom.values) values.add(v);
  }
  return { any, values };
}

function parseAtom(
  text: string,
  min: number,
  max: number,
  name: string,
): { readonly whole: true } | { readonly whole: false; readonly values: readonly number[] } | { readonly error: string } {
  const parts = text.split('/');
  const rangeText = parts[0] ?? '';
  const stepText = parts[1];
  const extra = parts[2];
  if (extra !== undefined) return { error: `${name}: '${text}' has more than one step` };
  let lo = min;
  let hi = max;
  if (rangeText !== '*') {
    const dash = rangeText.indexOf('-');
    if (dash === -1) {
      const single = Number(rangeText);
      if (!Number.isInteger(single)) return { error: `${name}: '${rangeText}' is not a number` };
      lo = single;
      hi = single;
    } else {
      lo = Number(rangeText.slice(0, dash));
      hi = Number(rangeText.slice(dash + 1));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return { error: `${name}: '${rangeText}' is not a range` };
    }
  }
  if (lo < min || hi > max) {
    return { error: `${name}: '${rangeText}' is outside ${String(min)}-${String(max)}` };
  }
  if (lo > hi) return { error: `${name}: '${rangeText}' has its range backwards` };
  if (stepText === undefined) {
    return rangeText === '*' ? { whole: true } : { whole: false, values: range(lo, hi, 1) };
  }
  const step = Number(stepText);
  if (!Number.isInteger(step) || step < 1) return { error: `${name}: step '${stepText}' is not a positive integer` };
  if (rangeText === '*' && step === 1) return { whole: true };
  return { whole: false, values: range(lo, hi, step) };
}

function range(lo: number, hi: number, step: number): readonly number[] {
  const values: number[] = [];
  for (let v = lo; v <= hi; v += step) values.push(v);
  return values;
}

/**
 * The next fire strictly after `afterMs`, in milliseconds since the epoch, or `null`
 * when the schedule matches nothing within the search horizon (a `Feb 30`-class
 * schedule). Minute-granular: two fires never land inside the same minute.
 */
export function nextFire(spec: CronSpec, afterMs: number): number | null {
  const start = new Date(afterMs);
  // Round up to the next minute boundary: a fire "at" 10:05:00 is not a fire in the
  // 10:04 minute, and a job that just fired at 10:05:00 must not refire at 10:05:59.
  let candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()).getTime();
  if (candidate <= afterMs) candidate += 60_000;

  for (let day = 0; day < SEARCH_LIMIT_DAYS; day++) {
    const date = new Date(candidate);
    if (!fieldMatches(spec.month, date.getMonth() + 1)) {
      candidate = nextDayAt(date, 0, 0);
      continue;
    }
    if (!dayMatches(spec, date)) {
      candidate = nextDayAt(date, 0, 0);
      continue;
    }
    // This day can match: walk its minutes. `candidate` may start mid-day.
    const endOfDay = nextDayAt(date, 0, 0);
    while (candidate < endOfDay) {
      const at = new Date(candidate);
      if (fieldMatches(spec.hour, at.getHours()) && fieldMatches(spec.minute, at.getMinutes())) {
        return candidate;
      }
      candidate += 60_000;
    }
  }
  return null;
}

/** `*` matches everything; a restricted field matches its set. */
function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

/** Vixie semantics: when both day fields are constrained, EITHER matching fires. */
function dayMatches(spec: CronSpec, date: Date): boolean {
  const domMatch = spec.dom.values.has(date.getDate());
  const dowMatch = spec.dow.values.has(date.getDay());
  if (spec.dom.any && spec.dow.any) return true;
  if (spec.dom.any) return dowMatch;
  if (spec.dow.any) return domMatch;
  return domMatch || dowMatch;
}

function nextDayAt(date: Date, hour: number, minute: number): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, hour, minute).getTime();
}

/**
 * Is this schedule due at `nowMs`, given that its last relevant instant was
 * `afterMs` (creation for a never-fired job, the last fire otherwise)?
 * Five-minute-step schedules count as due 15 seconds early (ADR-141 ⑥); everything else fires
 * on the minute.
 */
export function isDue(spec: CronSpec, afterMs: number, nowMs: number): boolean {
  const next = nextFire(spec, afterMs);
  if (next === null) return false;
  const ahead = spec.fiveMinuteStep ? DUE_AHEAD_MS : 0;
  return next - ahead <= nowMs;
}
