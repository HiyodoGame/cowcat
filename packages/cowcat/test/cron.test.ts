import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRON_MAX_JOBS,
  CRON_RECURRING_TTL_MS,
  DUE_AHEAD_MS,
  isDue,
  nextFire,
  parseSchedule,
} from '../src/policy/cron.js';

// Every "at" below is built from local components on purpose: the schedule dialect is
// defined in local time (ADR-141 ②), so the tests must not depend on the machine's
// zone. 9am means 9am wherever this runs.

function at(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function specOf(expression: string) {
  const parsed = parseSchedule(expression);
  if (!parsed.ok) assert.fail(`'${expression}' should parse, got: ${parsed.error}`);
  return parsed.spec;
}

test('the documented examples parse', () => {
  for (const example of ['*/5 * * * *', '0 * * * *', '7 * * * *', '0 9 * * *', '0 9 * * 1-5', '30 14 15 3 *']) {
    const parsed = parseSchedule(example);
    assert.equal(parsed.ok, true, example);
  }
  assert.equal(specOf('*/5 * * * *').fiveMinuteStep, true);
  assert.equal(specOf('*/10 * * * *').fiveMinuteStep, false);
  assert.equal(specOf('0,5,10,15,20,25,30,35,40,45,50,55 * * * *').fiveMinuteStep, true);
  assert.equal(specOf('5 * * * *').fiveMinuteStep, false);
});

test('extended syntax is refused with a reason, not half-understood', () => {
  for (const bad of ['0 9 * * MON', '0 9 L * *', '0 9 * * ?', '0 9 * * * *', '', '  ', '0 9 * *', 'a b c d e']) {
    const parsed = parseSchedule(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
  const named = parseSchedule('0 9 * * MON');
  if (named.ok) assert.fail('expected refusal');
  assert.match(named.error, /unsupported syntax/);
});

test('empty atoms are refused, not silently read as 0 (review P2-3)', () => {
  // Number('') is 0: without an explicit guard these would parse as "on the hour".
  for (const bad of ['5, * * * *', ',, * * * *', '/5 * * * *', '1- * * * *', '*/ * * * *']) {
    const parsed = parseSchedule(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
});

test('out-of-range values are refused per field', () => {
  for (const bad of ['60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-2 * * * *', '*/0 * * * *']) {
    const parsed = parseSchedule(bad);
    assert.equal(parsed.ok, false, bad);
  }
});

test('day-of-week accepts both 0 and 7 as Sunday', () => {
  // 2026-10-25 is a Sunday.
  const sun0 = nextFire(specOf('0 9 * * 0'), at(2026, 10, 24));
  const sun7 = nextFire(specOf('0 9 * * 7'), at(2026, 10, 24));
  assert.equal(sun0, at(2026, 10, 25, 9));
  assert.equal(sun7, at(2026, 10, 25, 9));
});

test('nextFire walks the documented cadences', () => {
  assert.equal(nextFire(specOf('*/5 * * * *'), at(2026, 10, 24, 10, 0, 0)), at(2026, 10, 24, 10, 5));
  assert.equal(nextFire(specOf('0 * * * *'), at(2026, 10, 24, 10, 0, 0)), at(2026, 10, 24, 11, 0));
  assert.equal(nextFire(specOf('7 * * * *'), at(2026, 10, 24, 10, 7, 0)), at(2026, 10, 24, 11, 7));
  // 10:05:00 just fired — the next fire is NOT still inside the 10:05 minute.
  assert.equal(nextFire(specOf('*/5 * * * *'), at(2026, 10, 24, 10, 5, 0)), at(2026, 10, 24, 10, 10));
  // A few seconds later in the same minute, same answer.
  assert.equal(nextFire(specOf('*/5 * * * *'), at(2026, 10, 24, 10, 5, 30)), at(2026, 10, 24, 10, 10));
});

test('nextFire crosses day, month and year boundaries in local time', () => {
  // 9pm → tomorrow 9am.
  assert.equal(nextFire(specOf('0 9 * * *'), at(2026, 10, 24, 21)), at(2026, 10, 25, 9));
  // Jan 31st, 11pm → Mar 15 (month constrained).
  assert.equal(nextFire(specOf('30 14 15 3 *'), at(2026, 1, 31, 23)), at(2026, 3, 15, 14, 30));
  // Dec 31st, after 9am → next year Jan 1.
  assert.equal(nextFire(specOf('0 9 * * *'), at(2026, 12, 31, 10)), at(2027, 1, 1, 9));
});

test('weekday ranges and lists select the expected days', () => {
  // 2026-10-24 is a Saturday; 1-5 is Mon-Fri. Next is Monday the 26th.
  assert.equal(nextFire(specOf('0 9 * * 1-5'), at(2026, 10, 24, 12)), at(2026, 10, 26, 9));
  // Friday 23:00, hourly list {0,15,30,45}: next is 23:15 the same day.
  assert.equal(nextFire(specOf('0,15,30,45 23 * * *'), at(2026, 10, 23, 22, 50)), at(2026, 10, 23, 23, 0));
});

test('vixie OR semantics: DOM and DOW both constrained means either fires', () => {
  // The 1st of the month OR a Monday, at noon. 2026-11-01 is a Sunday, 11-02 a Monday:
  // from 10-31 the Monday (11-02) comes before the 1st-of-month (12-01)... 11-01 is the
  // 1st of November and a Sunday — either way it fires there.
  const next = nextFire(specOf('0 12 1 * 1'), at(2026, 10, 31, 13));
  assert.equal(next, at(2026, 11, 1, 12));
  // Only-DOM constrained: 2026-11-01 is a Sunday but DOM says the 1st, so it still fires.
  assert.equal(nextFire(specOf('0 12 1 * *'), at(2026, 10, 31, 13)), at(2026, 11, 1, 12));
});

test('an impossible schedule has no fire within the horizon', () => {
  assert.equal(nextFire(specOf('0 0 30 2 *'), at(2026, 1, 1)), null);
  // And a due check over it is simply never due.
  assert.equal(isDue(specOf('0 0 30 2 *'), at(2026, 1, 1), at(2031, 1, 1)), false);
});

test('due checks: on the minute for ordinary schedules', () => {
  const hourly = specOf('0 * * * *');
  assert.equal(isDue(hourly, at(2026, 10, 24, 10, 0), at(2026, 10, 24, 10, 59, 59)), false);
  assert.equal(isDue(hourly, at(2026, 10, 24, 10, 0), at(2026, 10, 24, 11, 0)), true);
});

test('*/5 schedules count as due 15 seconds early (ADR-141 ⑥)', () => {
  const five = specOf('*/5 * * * *');
  const after = at(2026, 10, 24, 10, 0, 0);
  // 15s before the fire: due (cache warmth, ADR-141 ⑥).
  assert.equal(isDue(five, after, at(2026, 10, 24, 10, 4, 45)), true);
  // 16s before: not yet.
  assert.equal(isDue(five, after, at(2026, 10, 24, 10, 4, 44)), false);
  // Other schedules get no head start.
  const fifteen = specOf('*/15 * * * *');
  assert.equal(isDue(fifteen, after, at(2026, 10, 24, 10, 14, 45)), false);
  assert.equal(DUE_AHEAD_MS, 15_000);
});

test('the caps and TTL are the documented numbers', () => {
  assert.equal(CRON_MAX_JOBS, 50);
  assert.equal(CRON_RECURRING_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});
