// T3 — the cron scheduler in the assembled host (ADR-140~142). What only this layer can
// get wrong: a due job fires a turn only while the session is idle; the fired event names
// the turn it opens; a fired turn runs with the unattended narrowing; one-shots fire once;
// an unattended host offers no cron tools at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClient,
  createServer,
  memoryTransport,
  type WireEvent,
} from '@corescense/cowcat-protocol';
import { createHost, type Clock, type ModelPort } from '../src/index.js';
import { ScriptedModel } from './support.js';

const PRESET = 'anthropic/claude-sonnet-5-5';

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeUserConfig(home: string, body: unknown): void {
  const dir = join(home, '.cowcat');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(body)}\n`);
}

/** A manually advanced clock: the tests decide when a minute has passed. */
function fakeClock(startMs: number): { clock: Clock; advance(toMs: number): void; now: () => number } {
  let current = startMs;
  return {
    clock: { now: () => current },
    advance: (toMs) => {
      current = toMs;
    },
    now: () => current,
  };
}

// 10:00:30 local, on a fixed date: the next `* * * * *` fire is 10:01:00.
const T0 = new Date(2026, 9, 24, 10, 0, 30).getTime();

async function start(
  t: { after(fn: () => void): void },
  options: {
    readonly model: ModelPort;
    readonly clock: Clock;
    readonly unattended?: boolean;
    readonly config?: unknown;
    /** Share state between two hosts (the restart test): same dirs, same on-disk store. */
    readonly shared?: { readonly home: string; readonly cwd: string };
  },
): Promise<{
  client: ReturnType<typeof createClient>;
  events: () => readonly WireEvent[];
  until: (what: string, predicate: () => boolean) => Promise<void>;
  close: () => Promise<void>;
}> {
  // Owned dirs register their own cleanup; shared dirs belong to the caller's test.
  const home = options.shared?.home ?? tempDir(t, 'cowcat-cron-home-');
  const cwd = options.shared?.cwd ?? tempDir(t, 'cowcat-cron-proj-');
  if (options.shared === undefined) writeUserConfig(home, options.config ?? { model: { preset: PRESET } });

  const host = await createHost({
    cwd,
    home,
    env: {},
    version: '0.0.0-test',
    model: options.model,
    approvalTimeoutMs: 5_000,
    clock: options.clock,
    ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
  });
  const pair = memoryTransport();
  const server = createServer({ host, transport: pair.server });
  const client = createClient({ transport: pair.client });

  const events: WireEvent[] = [];
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  client.on('event', (event) => {
    events.push(event);
    wake();
  });

  async function until(what: string, predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          waiters.delete(settle);
          resolve();
        };
        waiters.add(settle);
        setTimeout(settle, 20);
      });
    }
  }

  return {
    client,
    events: () => events,
    until,
    close: async () => {
      client.close();
      await server.closed;
      await host.close();
    },
  };
}

function field(event: WireEvent | undefined, name: string): unknown {
  return event === undefined ? undefined : Reflect.get(event, name);
}

const cronCreate = (callId: string, prompt: string, recurring = false, schedule = '* * * * *') => ({
  type: 'tool_call' as const,
  call: { callId, name: 'CronCreate', input: { schedule, prompt, recurring } },
});

/** Answer every approval the session asks for, as it asks. */
function autoApprove(
  fx: { client: ReturnType<typeof createClient>; events: () => readonly WireEvent[] },
  sessionId: string,
  answered: Set<string>,
): void {
  for (const event of fx.events()) {
    if (event.type !== 'approval.requested') continue;
    const callId = field(event, 'callId');
    if (typeof callId !== 'string' || answered.has(callId)) continue;
    answered.add(callId);
    void fx.client.respondApproval(sessionId, callId, 'once');
  }
}

test('a due job fires between turns; the fired event names the turn it opens (ADR-140/141)', async (t) => {
  const time = fakeClock(T0);
  const model = new ScriptedModel([
    [cronCreate('c1', 'poll the deploy')],
    [{ type: 'text', text: 'scheduled' }],
    [{ type: 'text', text: 'deploy is green' }],
  ]);
  const fx = await start(t, { model, clock: time.clock });
  t.after(() => fx.close());
  await fx.client.initialize();
  await fx.client.createSession('sess_cron_fire');
  await fx.client.openSession('sess_cron_fire');

  const answered = new Set<string>();
  const send = fx.client.sendTurn('sess_cron_fire', 'keep an eye on the deploy');
  await fx.until('the CronCreate approval', () => fx.events().some((event) => event.type === 'approval.requested'));
  autoApprove(fx, 'sess_cron_fire', answered);
  await send;
  await fx.until('the setup turn to complete', () =>
    fx.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  assert.equal(fx.events().some((event) => event.type === 'cron.created'), true);

  // No fire before the scheduled minute, even though the session has been idle.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(fx.events().some((event) => event.type === 'cron.fired'), false, 'not due yet');

  // Advance the clock past 10:01:00: the heartbeat fires the job.
  time.advance(new Date(2026, 9, 24, 10, 1, 0).getTime());
  await fx.until('the cron fire', () => fx.events().some((event) => event.type === 'cron.fired'));
  await fx.until('the cron turn to complete', () =>
    fx.events().filter((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed').length >= 2,
  );

  const fired = fx.events().find((event) => event.type === 'cron.fired');
  const opened = fx.events().find((event) => event.type === 'turn.opened' && field(event, 'input') === 'poll the deploy');
  assert.equal(field(fired, 'turnId'), field(opened, 'turnId'), 'the fired event names the turn it opened');

  // One-shot: a second minute must NOT produce a second fire.
  time.advance(new Date(2026, 9, 24, 10, 2, 0).getTime());
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(fx.events().filter((event) => event.type === 'cron.fired').length, 1, 'one-shots fire exactly once');
});

test('a fired cron turn cannot ask: the unattended narrowing refuses the write (ADR-142)', async (t) => {
  const time = fakeClock(T0);
  const writeCall = {
    type: 'tool_call' as const,
    call: { callId: 'c2', name: 'Write', input: { file_path: 'note.txt', content: 'x' } },
  };
  const model = new ScriptedModel([
    [cronCreate('c1', 'write the status file')],
    [{ type: 'text', text: 'scheduled' }],
    [writeCall],
    [{ type: 'text', text: 'could not write: cron turns cannot ask a human' }],
  ]);
  const fx = await start(t, { model, clock: time.clock });
  t.after(() => fx.close());
  await fx.client.initialize();
  await fx.client.createSession('sess_cron_unatt');
  await fx.client.openSession('sess_cron_unatt');

  const answered = new Set<string>();
  const send = fx.client.sendTurn('sess_cron_unatt', 'set up the status writer');
  await fx.until('the CronCreate approval', () => fx.events().some((event) => event.type === 'approval.requested'));
  autoApprove(fx, 'sess_cron_unatt', answered);
  await send;
  // Settle the setup turn BEFORE touching the clock: the send reply can outrun the
  // turn itself, and a createdAt stamped after the advance would push the next fire
  // a minute further than this test ever reaches.
  await fx.until('the setup turn to complete', () =>
    fx.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );
  assert.equal(fx.events().some((event) => event.type === 'cron.created'), true);

  time.advance(new Date(2026, 9, 24, 10, 1, 0).getTime());
  await fx.until('the cron fire', () => fx.events().some((event) => event.type === 'cron.fired'));
  await fx.until('the cron turn to complete', () =>
    fx.events().filter((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed').length >= 2,
  );

  const refused = fx.events().find((event) => event.type === 'tool.finished' && field(event, 'name') === 'Write');
  assert.equal(field(refused, 'ok'), false);
  assert.match(String(field(refused, 'output')), /cron turns cannot ask a human/);
  // The question is recorded, but the ANSWER is the unattended refusal — not a user, not
  // a timeout (the whole turn finished in about a second, far under the 5s timeout).
  const answer = fx.events().find((event) => event.type === 'approval.answered' && field(event, 'callId') === 'c2');
  assert.equal(field(answer, 'by'), 'unattended');
});

test('a busy session waits: the due job fires only after the running turn ends (ADR-141 ①)', async (t) => {
  const time = fakeClock(T0);
  const writeCall = {
    type: 'tool_call' as const,
    call: { callId: 'c2', name: 'Write', input: { file_path: 'note.txt', content: 'x' } },
  };
  const model = new ScriptedModel([
    [cronCreate('c1', 'poll after the write')],
    [writeCall],
    [{ type: 'text', text: 'write done' }],
    [{ type: 'text', text: 'polled' }],
  ]);
  const fx = await start(t, { model, clock: time.clock });
  t.after(() => fx.close());
  await fx.client.initialize();
  await fx.client.createSession('sess_cron_busy');
  await fx.client.openSession('sess_cron_busy');

  const answered = new Set<string>();
  const send = fx.client.sendTurn('sess_cron_busy', 'set it up, then write a file');
  // Approve the CronCreate, then let the Write SIT unanswered: the session is busy.
  await fx.until('the CronCreate approval', () => fx.events().some((event) => event.type === 'approval.requested'));
  autoApprove(fx, 'sess_cron_busy', answered);
  await fx.until('the Write approval', () =>
    fx.events().some((event) => event.type === 'approval.requested' && field(event, 'callId') === 'c2'),
  );

  // The minute passes while the user turn is parked on the approval: no fire, no catch-up.
  time.advance(new Date(2026, 9, 24, 10, 1, 0).getTime());
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(fx.events().some((event) => event.type === 'cron.fired'), false, 'a busy session does not fire');

  // Answer: the turn completes, and the due job fires on a later heartbeat (no catch-up
  // burst — exactly one fire for the missed minute).
  autoApprove(fx, 'sess_cron_busy', answered);
  await send;
  await fx.until('the cron fire', () => fx.events().some((event) => event.type === 'cron.fired'));
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(fx.events().filter((event) => event.type === 'cron.fired').length, 1);
});

test('a */5 job fired early does NOT double-fire the same slot (review P0-1)', async (t) => {
  const time = fakeClock(new Date(2026, 9, 24, 10, 0, 0).getTime());
  const model = new ScriptedModel([
    [cronCreate('c1', 'poll every five', true, '*/5 * * * *')],
    [{ type: 'text', text: 'scheduled' }],
    [{ type: 'text', text: 'polled' }],
  ]);
  const fx = await start(t, { model, clock: time.clock });
  t.after(() => fx.close());
  await fx.client.initialize();
  await fx.client.createSession('sess_cron_star5');
  await fx.client.openSession('sess_cron_star5');

  const answered = new Set<string>();
  const send = fx.client.sendTurn('sess_cron_star5', 'set up the five-minute poll');
  await fx.until('the CronCreate approval', () => fx.events().some((event) => event.type === 'approval.requested'));
  autoApprove(fx, 'sess_cron_star5', answered);
  await send;
  await fx.until('the job to exist', () => fx.events().some((event) => event.type === 'cron.created'));

  // */5 fires 15s early (ADR-141 ⑥): 10:04:45, slot anchored at 10:05:00 by the fold.
  time.advance(new Date(2026, 9, 24, 10, 4, 45).getTime());
  await fx.until('the cron fire', () => fx.events().some((event) => event.type === 'cron.fired'));
  await fx.until('the cron turn to complete', () =>
    fx.events().filter((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed').length >= 2,
  );

  // Walk past the slot: the anchored lastFiredAt (10:05:00) must keep 10:05:00 from re-firing.
  time.advance(new Date(2026, 9, 24, 10, 5, 30).getTime());
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.equal(
    fx.events().filter((event) => event.type === 'cron.fired').length,
    1,
    'the same slot fired once; the early-fire anchor prevents the double',
  );

  // And the NEXT slot (10:10:00, again 15s early) still fires.
  time.advance(new Date(2026, 9, 24, 10, 9, 45).getTime());
  await fx.until('the second fire', () => fx.events().filter((event) => event.type === 'cron.fired').length >= 2);
});

test('a host restart does not silence existing jobs: resume materializes the table (review P0-2)', async (t) => {
  const time = fakeClock(T0);
  const model = new ScriptedModel([
    [cronCreate('c1', 'survive the restart', true)],
    [{ type: 'text', text: 'scheduled' }],
    [{ type: 'text', text: 'still here' }],
  ]);
  // Both hosts share one state dir: host A exits, host B is the "resume" over the same log.
  const home = tempDir(t, 'cowcat-cron-restart-home-');
  const cwd = tempDir(t, 'cowcat-cron-restart-proj-');
  writeUserConfig(home, { model: { preset: PRESET } });
  const shared = { home, cwd };
  // First host: create the job, then close (simulating a process exit).
  {
    const fx = await start(t, { model, clock: time.clock, shared });
    await fx.client.initialize();
    await fx.client.createSession('sess_cron_resume');
    await fx.client.openSession('sess_cron_resume');
    const answered = new Set<string>();
    const send = fx.client.sendTurn('sess_cron_resume', 'make a job that outlives this process');
    await fx.until('the CronCreate approval', () => fx.events().some((event) => event.type === 'approval.requested'));
    autoApprove(fx, 'sess_cron_resume', answered);
    await send;
    await fx.until('the job to exist', () => fx.events().some((event) => event.type === 'cron.created'));
    await fx.close();
  }

  // Second host over the same on-disk store: opening the session (a resume) must let
  // the scheduler see the job — the tick only walks materialized tables.
  {
    const fx = await start(t, { model, clock: time.clock, shared });
    t.after(() => fx.close());
    await fx.client.initialize();
    await fx.client.openSession('sess_cron_resume');

    const jobs = await fx.client.listCronJobs('sess_cron_resume');
    assert.equal(jobs.length, 1, 'the job survived on disk');

    time.advance(new Date(2026, 9, 24, 10, 1, 0).getTime());
    await fx.until('the fire after the restart', () => fx.events().some((event) => event.type === 'cron.fired'));
  }
});

test('an unattended host offers no cron tools (ADR-112 同款纪律)', async (t) => {
  const time = fakeClock(T0);
  const model = new ScriptedModel([
    [cronCreate('c1', 'never')],
    [{ type: 'text', text: 'no such tool' }],
  ]);
  const fx = await start(t, { model, clock: time.clock, unattended: true });
  t.after(() => fx.close());
  await fx.client.initialize();
  await fx.client.createSession('sess_cron_unattended');
  await fx.client.openSession('sess_cron_unattended');

  await fx.client.sendTurn('sess_cron_unattended', 'try to schedule');
  await fx.until('the turn to complete', () =>
    fx.events().some((event) => event.type === 'turn.transitioned' && field(event, 'to') === 'completed'),
  );

  // Absent from the wire, the call reads as an unknown tool; nothing is scheduled.
  const finished = fx.events().find((event) => event.type === 'tool.finished' && field(event, 'name') === 'CronCreate');
  assert.equal(field(finished, 'ok'), false);
  assert.equal(fx.events().some((event) => event.type === 'cron.created'), false);

  // Even past the due minute, nothing fires: there is no scheduler in an unattended host.
  time.advance(new Date(2026, 9, 24, 10, 2, 0).getTime());
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(fx.events().some((event) => event.type === 'cron.fired'), false);
});

test('the /cron panel path: list, remove, and the deletion is the user log fact (ADR-143 ②)', async (t) => {
  const time = fakeClock(T0);
  const model = new ScriptedModel([
    [cronCreate('c1', 'panel job')],
    [{ type: 'text', text: 'scheduled' }],
  ]);
  const fx = await start(t, { model, clock: time.clock });
  t.after(() => fx.close());
  await fx.client.initialize();
  await fx.client.createSession('sess_cron_panel');
  await fx.client.openSession('sess_cron_panel');

  const answered = new Set<string>();
  const send = fx.client.sendTurn('sess_cron_panel', 'make a job');
  await fx.until('the CronCreate approval', () => fx.events().some((event) => event.type === 'approval.requested'));
  autoApprove(fx, 'sess_cron_panel', answered);
  await send;
  // The send reply can outrun the turn itself: wait until the job is a log fact before
  // asking the panel to list it (same race as the clock-advance tests above).
  await fx.until('the job to exist', () => fx.events().some((event) => event.type === 'cron.created'));

  const jobs = await fx.client.listCronJobs('sess_cron_panel');
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.ok(job !== undefined);
  assert.equal(job.schedule, '* * * * *');
  assert.equal(job.prompt, 'panel job');

  assert.equal(await fx.client.removeCronJob('sess_cron_panel', job.jobId), true);
  assert.equal(await fx.client.removeCronJob('sess_cron_panel', 'job_ghost'), false);

  await fx.until('the user deletion in the log', () => fx.events().some((event) => event.type === 'cron.deleted'));
  const deleted = fx.events().find((event) => event.type === 'cron.deleted');
  assert.equal(field(deleted, 'by'), 'user');
  assert.deepEqual(await fx.client.listCronJobs('sess_cron_panel'), []);
});
