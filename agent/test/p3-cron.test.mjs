// P3: cron scheduling — CronCreate / CronDelete / CronList / ScheduleWakeup.
// In-process runLoop + MockProvider for the tools (same pattern as
// p3-tasks.test.mjs), direct unit tests for the parser / nextFire / due-sweep.
// Persistence is isolated via COWCAT_HOME -> per-test temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import {
  CronCreateTool, CronDeleteTool, CronListTool, ScheduleWakeupTool,
  parseCron, nextFire, loadCrons, saveCrons, cronsFile, takeDueCrons, cronFirePrompt,
} from '../src/tools/cron.js';
import { Permissions } from '../src/permissions.js';
import { MockUI } from '../src/ui.js';
import { runLoop } from '../src/loop.js';
import { MockProvider, text, toolUse } from './mock-provider.js';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeRegistry() {
  const reg = new ToolRegistry();
  for (const t of [CronCreateTool, CronDeleteTool, CronListTool, ScheduleWakeupTool]) reg.register(t);
  return reg;
}

function makeCtx(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-cron-'));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
  process.env.COWCAT_HOME = home;
  return {
    cwd, home, readSet: new Set(), state: {}, sessionId: 'test-session-cron',
    ui: new MockUI(), permissions: new Permissions('yolo'),
    config: { maxTokens: 1024, maxContextTokens: 100000 },
    ...over,
  };
}

async function run(script, { messages, ctx } = {}) {
  const provider = new MockProvider(script);
  const registry = makeRegistry();
  const finalCtx = ctx || makeCtx();
  const res = await runLoop({
    provider, registry, system: 'You are a test agent.', messages: messages || [], ctx: finalCtx,
    ui: finalCtx.ui, permissions: finalCtx.permissions, config: finalCtx.config,
  });
  return { ...res, provider, ctx: finalCtx };
}

const SYS_MSGS = (s) => [{ role: 'user', content: s }];

// --- parseCron: valid expressions ------------------------------------------------

test('cron: parseCron accepts common valid expressions', () => {
  const every = parseCron('* * * * *');
  assert.equal(every.minute.length, 60);
  assert.equal(every.hour.length, 24);
  assert.equal(every.dom.length, 31);
  assert.equal(every.month.length, 12);
  assert.equal(every.dow.length, 7);

  const quarter = parseCron('*/15 * * * *');
  assert.deepEqual(quarter.minute, [0, 15, 30, 45]);

  const weekdays = parseCron('0,30 9-17 * * 1-5');
  assert.deepEqual(weekdays.minute, [0, 30]);
  assert.deepEqual(weekdays.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(weekdays.dow, [1, 2, 3, 4, 5]);

  const stepped = parseCron('1-10/2 0 1 * 0,7');
  assert.deepEqual(stepped.minute, [1, 3, 5, 7, 9]);
  assert.deepEqual(stepped.dow, [0], '7 normalizes to Sunday 0');
  assert.equal(stepped.domRestricted, true);
  assert.equal(stepped.dowRestricted, true);
});

test('cron: parseCron rejects invalid expressions with helpful errors', () => {
  assert.throws(() => parseCron('61 * * * *'), /out of bounds/);
  assert.throws(() => parseCron('* * *'), /exactly 5 fields/);
  assert.throws(() => parseCron('* * * *'), /exactly 5 fields/);
  assert.throws(() => parseCron('a b c d e'), /invalid "a"/);
  assert.throws(() => parseCron('5-1 * * * *'), /out of bounds/);
  assert.throws(() => parseCron('*/0 * * * *'), /positive integer/);
  assert.throws(() => parseCron('0 0 32 * *'), /out of bounds/);
  assert.throws(() => parseCron('0 0 * 13 *'), /out of bounds/);
});

// --- nextFire --------------------------------------------------------------------

test('cron: nextFire lands on the next minute boundary for */15', () => {
  // Monday 2025-01-06 10:07:30 local
  const from = new Date(2025, 0, 6, 10, 7, 30);
  const fire = nextFire(parseCron('*/15 * * * *'), from);
  assert.equal(fire.getMinutes(), 15);
  assert.equal(fire.getHours(), 10);
  assert.equal(fire.getDate(), 6);
  assert.equal(fire.getSeconds(), 0);
});

test('cron: nextFire rolls to the next day for a passed daily time', () => {
  const from = new Date(2025, 0, 6, 10, 7, 30);
  const fire = nextFire(parseCron('0 9 * * *'), from);
  assert.equal(fire.getDate(), 7);
  assert.equal(fire.getHours(), 9);
  assert.equal(fire.getMinutes(), 0);
});

test('cron: nextFire skips to the next weekday for 9-5 weekday schedules', () => {
  const from = new Date(2025, 0, 10, 18, 0, 0); // Friday 18:00
  const fire = nextFire(parseCron('0 9 * * 1-5'), from);
  assert.equal(fire.getDay(), 1, 'skips the weekend to Monday');
  assert.equal(fire.getDate(), 13);
  assert.equal(fire.getHours(), 9);
});

test('cron: nextFire handles sparse schedules (Feb 29) within 5 years', () => {
  const from = new Date(2025, 0, 6, 10, 0, 0);
  const fire = nextFire(parseCron('0 0 29 2 *'), from);
  assert.equal(fire.getMonth(), 1);
  assert.equal(fire.getDate(), 29);
  assert.equal(fire.getFullYear() % 4, 0, 'lands on a leap year');
  assert.ok(fire.getTime() > from.getTime());
});

test('cron: nextFire uses OR semantics when both day fields are restricted', () => {
  // Every Friday, plus the 13th of any month (classic cron OR rule).
  const from = new Date(2025, 0, 6, 10, 0, 0); // Monday the 6th
  const fire = nextFire(parseCron('0 0 13 * 5'), from);
  assert.equal(fire.getDate(), 10, 'Friday the 10th comes before Monday the 13th');
  assert.equal(fire.getDay(), 5);
});

test('cron: nextFire is strictly after `from` for a matching minute', () => {
  const from = new Date(2025, 0, 6, 10, 7, 0, 0); // exactly 10:07:00
  const fire = nextFire(parseCron('7 * * * *'), from);
  assert.equal(fire.getHours(), 11, 'the 10:07 slot is not strictly after `from`');
});

// --- CronCreate through the loop -------------------------------------------------

test('cron: CronCreate returns id + nextFireAt and persists to crons.json', async () => {
  const { messages, ctx } = await run([
    toolUse('tu_1', 'CronCreate', { cron: '*/15 * * * *', prompt: 'check the build' }),
    toolUse('tu_2', 'CronCreate', { cron: '0 9 * * *', prompt: 'morning standup', recurring: false }),
    text('scheduled'),
  ], { messages: SYS_MSGS('set up reminders') });

  const r1 = JSON.parse(messages[2].content[0].content);
  assert.equal(messages[2].content[0].is_error, undefined);
  assert.match(r1.id, /^cron-/);
  assert.equal(r1.recurring, true, 'recurring defaults to true');
  const next1 = Date.parse(r1.nextFireAt);
  assert.ok(next1 > Date.now() && next1 < Date.now() + 16 * 60 * 1000);

  const r2 = JSON.parse(messages[4].content[0].content);
  assert.equal(r2.recurring, false);

  // persisted under the isolated COWCAT_HOME
  const file = join(ctx.home, 'crons.json');
  assert.ok(existsSync(file), 'crons.json written under COWCAT_HOME');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.length, 2);
  assert.equal(stored[0].prompt, 'check the build');
  assert.equal(stored[0].sessionId, 'test-session-cron');
  assert.ok(stored[0].cwd);
});

test('cron: CronCreate rejects an invalid cron expression through the loop', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'CronCreate', { cron: 'not a cron', prompt: 'x' }),
    text('done'),
  ], { messages: SYS_MSGS('go') });
  assert.equal(messages[2].content[0].is_error, true);
  assert.match(messages[2].content[0].content, /CronCreate/);
});

// --- due sweep (the REPL idle hook) ------------------------------------------------

test('cron: takeDueCrons injects due prompts; one-shots are removed, recurring re-arm', () => {
  const ctx = makeCtx();
  const past = new Date(Date.now() - 60_000).toISOString();
  saveCrons([
    { id: 'w1', cron: null, prompt: 'wake up and continue', recurring: false, nextFireAt: past, createdAt: past },
    { id: 'c1', cron: '*/5 * * * *', prompt: 'keep polling', recurring: true, nextFireAt: past, createdAt: past },
    { id: 'c2', cron: '0 9 * * *', prompt: 'not due yet', recurring: true, nextFireAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: past },
  ]);

  const due = takeDueCrons();
  assert.equal(due.length, 2);
  const w = due.find((d) => d.id === 'w1');
  assert.ok(w.prompt.includes('<cron-fire'), 'prompt wrapped in cron-fire envelope');
  assert.ok(w.prompt.includes('wake up and continue'));
  const c = due.find((d) => d.id === 'c1');
  assert.equal(c.recurring, true);

  const remaining = loadCrons();
  assert.deepEqual(remaining.map((j) => j.id).sort(), ['c1', 'c2'], 'one-shot w1 deleted after firing');
  const rearmed = remaining.find((j) => j.id === 'c1');
  assert.ok(Date.parse(rearmed.nextFireAt) > Date.now(), 'recurring job advanced past now');
  const untouched = remaining.find((j) => j.id === 'c2');
  assert.ok(Date.parse(untouched.nextFireAt) > Date.now() + 3000_000, 'not-due job untouched');
});

test('cron: takeDueCrons with sessionId only fires this session\'s jobs; foreign jobs stay armed', () => {
  const ctx = makeCtx();
  const past = new Date(Date.now() - 60_000).toISOString();
  saveCrons([
    { id: 'mine', cron: null, prompt: 'mine', recurring: false, nextFireAt: past, createdAt: past, sessionId: 'sess-A' },
    { id: 'theirs', cron: null, prompt: 'theirs', recurring: false, nextFireAt: past, createdAt: past, sessionId: 'sess-B' },
    { id: 'legacy', cron: null, prompt: 'legacy', recurring: false, nextFireAt: past, createdAt: past },
  ]);

  const due = takeDueCrons(new Date(), { sessionId: 'sess-A' });
  assert.deepEqual(due.map((d) => d.id).sort(), ['legacy', 'mine'], 'own + legacy jobs fire');

  const remaining = loadCrons();
  assert.deepEqual(remaining.map((j) => j.id), ['theirs'], 'foreign job survives, not fired, not deleted');

  // no opts -> full sweep (backwards compatible)
  saveCrons([
    { id: 'x', cron: null, prompt: 'x', recurring: false, nextFireAt: past, createdAt: past, sessionId: 'sess-B' },
  ]);
  assert.deepEqual(takeDueCrons().map((d) => d.id), ['x']);
  assert.equal(loadCrons().length, 0);
});

test('cron: cronFirePrompt marks recurring vs one-shot', () => {
  const rec = cronFirePrompt({ id: 'a', cron: '*/5 * * * *', recurring: true, prompt: 'ping' });
  assert.match(rec, /kind="recurring cron"/);
  assert.match(rec, /cron="\*\/5 \* \* \* \*"/);
  const once = cronFirePrompt({ id: 'b', cron: null, recurring: false, prompt: 'ping' });
  assert.match(once, /kind="one-shot wakeup"/);
});

// --- CronDelete / CronList ---------------------------------------------------------

test('cron: CronDelete removes by id; unknown id errors', async () => {
  const { messages, ctx } = await run([
    toolUse('tu_1', 'CronCreate', { cron: '0 9 * * *', prompt: 'morning' }),
    toolUse('tu_2', 'CronDelete', { id: 'BOGUS' }),
    text('done'),
  ], { messages: SYS_MSGS('go') });
  const created = JSON.parse(messages[2].content[0].content);
  assert.equal(messages[4].content[0].is_error, true, 'deleting BOGUS fails in the first turn');
  assert.match(messages[4].content[0].content, /Unknown scheduled task: BOGUS/);

  const { messages: m2 } = await run([
    toolUse('tv_1', 'CronDelete', { id: created.id }),
    toolUse('tv_2', 'CronList', {}),
    text('gone'),
  ], { messages: SYS_MSGS('second'), ctx });

  assert.match(m2[2].content[0].content, /"deleted"/);
  const list = JSON.parse(m2[4].content[0].content);
  assert.equal(list.count, 0, 'deleted job is gone from disk');
  assert.equal(loadCrons().length, 0);
});

test('cron: CronList summarizes jobs with id/cron/nextFireAt/prompt/recurring', async () => {
  const { ctx } = await run([
    toolUse('tu_1', 'CronCreate', { cron: '0 9 * * *', prompt: 'standup time' }),
    toolUse('tu_2', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'check the CI run', reason: 'ci pending' }),
    text('ok'),
  ], { messages: SYS_MSGS('schedule') });

  const { messages } = await run([
    toolUse('tv_1', 'CronList', {}),
    text('listed'),
  ], { messages: SYS_MSGS('list'), ctx });

  const list = JSON.parse(messages[2].content[0].content);
  assert.equal(list.count, 2);
  const cronJob = list.tasks.find((t) => t.cron === '0 9 * * *');
  assert.equal(cronJob.recurring, true);
  assert.equal(cronJob.prompt, 'standup time');
  assert.match(cronJob.id, /^cron-/);
  const wake = list.tasks.find((t) => t.cron === null);
  assert.equal(wake.recurring, false);
  assert.match(wake.prompt, /ci pending/);
  assert.match(wake.id, /^wake-/);
});

// --- ScheduleWakeup ------------------------------------------------------------------

test('cron: ScheduleWakeup creates a one-shot job firing after the delay', async () => {
  const before = Date.now();
  const { messages, ctx } = await run([
    toolUse('tu_1', 'ScheduleWakeup', { delaySeconds: 120, prompt: 'resume the task', reason: 'waiting on build' }),
    text('wakeup scheduled'),
  ], { messages: SYS_MSGS('wake me later') });

  const r = JSON.parse(messages[2].content[0].content);
  assert.equal(messages[2].content[0].is_error, undefined);
  assert.match(r.id, /^wake-/);
  assert.equal(r.recurring, false);
  const wakeAt = Date.parse(r.wakeAt);
  assert.ok(wakeAt >= before + 120_000 - 1000 && wakeAt <= Date.now() + 121_000, 'wakeAt ≈ now + 120s');

  const stored = loadCrons();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].recurring, false);
  assert.equal(stored[0].cron, null);
  assert.match(stored[0].prompt, /waiting on build/);
});

test('cron: ScheduleWakeup validates delay and prompt', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'ScheduleWakeup', { prompt: 'no delay' }),
    toolUse('tu_2', 'ScheduleWakeup', { delaySeconds: -5, prompt: 'negative' }),
    toolUse('tu_3', 'ScheduleWakeup', { delaySeconds: 10 }),
    toolUse('tu_4', 'ScheduleWakeup', { delaySeconds: 999999, prompt: 'too far' }),
    text('done'),
  ], { messages: SYS_MSGS('go') });
  assert.equal(messages[2].content[0].is_error, true);
  assert.match(messages[2].content[0].content, /delaySeconds or delayMs/);
  assert.equal(messages[4].content[0].is_error, true);
  assert.match(messages[4].content[0].content, /non-negative/);
  assert.equal(messages[6].content[0].is_error, true);
  assert.match(messages[6].content[0].content, /prompt/);
  assert.equal(messages[8].content[0].is_error, true);
  assert.match(messages[8].content[0].content, /24h/);
});

test('cron: delayMs is accepted as an alternative to delaySeconds', async () => {
  const { messages } = await run([
    toolUse('tu_1', 'ScheduleWakeup', { delayMs: 500, prompt: 'half a second later' }),
    text('ok'),
  ], { messages: SYS_MSGS('go') });
  const r = JSON.parse(messages[2].content[0].content);
  assert.equal(r.delayMs, 500);
  assert.ok(Date.parse(r.wakeAt) - Date.now() <= 1500);
});

// --- persistence robustness / permissions ---------------------------------------------

test('cron: corrupt crons.json falls back to an empty list', () => {
  const ctx = makeCtx();
  writeFileSync(cronsFile(), '{ not json !!!');
  assert.deepEqual(loadCrons(), []);
  // and the tools still work on top of it
  const r = CronListTool.execute({}, ctx);
  assert.equal(JSON.parse(r.output).count, 0);
});

test('cron: crons file location honors COWCAT_HOME', () => {
  const ctx = makeCtx();
  assert.equal(cronsFile(), join(ctx.home, 'crons.json'));
});

test('cron: scheduling tools are whitelisted read-only (allowed in plan mode)', () => {
  const p = new Permissions('plan');
  for (const name of ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']) {
    assert.equal(p.planReject(name, {}), null, `${name} allowed in plan mode`);
  }
});

test('cron: AGENT_ROOT sanity (keeps import used across refactors)', () => {
  assert.ok(AGENT_ROOT.endsWith('agent'));
});
