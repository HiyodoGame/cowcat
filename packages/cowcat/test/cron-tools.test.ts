import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, runTurn, Session, type ConfigSource, type CronJobInfo, type CronTasksPort, type ToolPort } from '../src/index.js';
import { createCronTools } from '../src/adapters/tools/cron.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

// A fake job table with just enough truth for the tools: create refuses above the cap,
// remove is ownership-checked, list projects what was created minus what was removed.

function fakeCron(existing = 0): { port: CronTasksPort; jobs: CronJobInfo[]; removed: string[] } {
  const jobs: CronJobInfo[] = Array.from({ length: existing }, (_, i) => ({
    jobId: `job_existing_${String(i)}`,
    schedule: '0 9 * * *',
    prompt: 'poll',
    recurring: true,
    createdAt: 1,
    expiresAt: 1 + 7 * 24 * 60 * 60 * 1000,
    nextRun: null,
    lastFiredAt: null,
  }));
  const removed: string[] = [];
  let next = 0;
  const port: CronTasksPort = {
    async create(request) {
      if (jobs.length >= 50) return { ok: false, error: 'this session already has 50 live jobs; delete some with CronDelete first' };
      const job: CronJobInfo = {
        jobId: `job_${String(++next)}`,
        schedule: request.schedule,
        prompt: request.prompt,
        recurring: request.recurring,
        createdAt: 1000,
        expiresAt: request.recurring ? 1000 + 7 * 24 * 60 * 60 * 1000 : null,
        nextRun: null,
        lastFiredAt: null,
      };
      jobs.push(job);
      return { ok: true, job, nextRun: null };
    },
    async remove(jobId) {
      const index = jobs.findIndex((job) => job.jobId === jobId);
      if (index === -1) return false;
      jobs.splice(index, 1);
      removed.push(jobId);
      return true;
    },
    async list() {
      return jobs;
    },
  };
  return { port, jobs, removed };
}

function toolByName(tools: readonly ToolPort[], name: string): ToolPort {
  const found = tools.find((candidate) => candidate.spec.name === name);
  if (found === undefined) assert.fail(`expected a ${name} tool`);
  return found;
}

test('no cron port means no cron tools (ADR-143 ④: absence, not a refusing fake)', () => {
  assert.deepEqual(createCronTools({}), []);
});

test('CronCreate refuses a malformed schedule without touching the port', async () => {
  const fake = fakeCron();
  const create = toolByName(createCronTools({ cron: fake.port }), 'CronCreate');
  const result = await create.run(
    { schedule: '0 9 * * MON', prompt: 'check', recurring: false },
    new AbortController().signal,
    { networkApproved: false, unsandboxedApproved: false },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /unsupported syntax/);
  assert.equal(fake.jobs.length, 0);
});

test('CronCreate reports the port refusal (the 50-job cap) as an ordinary failure', async () => {
  const fake = fakeCron(50);
  const create = toolByName(createCronTools({ cron: fake.port }), 'CronCreate');
  const result = await create.run(
    { schedule: '*/5 * * * *', prompt: 'poll', recurring: true },
    new AbortController().signal,
    { networkApproved: false, unsandboxedApproved: false },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /50 live jobs/);
});

test('CronCreate success carries the created fact for the kernel to log (ADR-140)', async () => {
  const fake = fakeCron();
  const create = toolByName(createCronTools({ cron: fake.port }), 'CronCreate');
  const result = await create.run(
    { schedule: '*/5 * * * *', prompt: 'check the deploy', recurring: true },
    new AbortController().signal,
    { networkApproved: false, unsandboxedApproved: false },
  );
  assert.equal(result.ok, true);
  const created = result.cronCreated;
  assert.ok(created !== undefined);
  assert.equal(created.jobId, 'job_1');
  assert.equal(created.schedule, '*/5 * * * *');
  assert.equal(created.recurring, true);
  assert.match(result.output, /scheduled job job_1/);
  assert.match(result.output, /cannot ask approvals/);
});

test('CronList answers with the live jobs, empty when there are none', async () => {
  const fake = fakeCron();
  const tools = createCronTools({ cron: fake.port });
  const list = toolByName(tools, 'CronList');
  const empty = await list.run({}, new AbortController().signal, { networkApproved: false, unsandboxedApproved: false });
  assert.equal(empty.ok, true);
  assert.match(empty.output, /No scheduled jobs/);

  await toolByName(tools, 'CronCreate').run(
    { schedule: '0 9 * * *', prompt: 'morning check', recurring: false },
    new AbortController().signal,
    { networkApproved: false, unsandboxedApproved: false },
  );
  const listed = await list.run({}, new AbortController().signal, { networkApproved: false, unsandboxedApproved: false });
  assert.equal(listed.ok, true);
  assert.match(listed.output, /job_1/);
  assert.match(listed.output, /one-shot/);
  assert.match(listed.output, /morning check/);
});

test('CronDelete: unknown id fails, known id carries the deleted fact', async () => {
  const fake = fakeCron();
  const tools = createCronTools({ cron: fake.port });
  const del = toolByName(tools, 'CronDelete');
  const missing = await del.run({ jobId: 'job_nope' }, new AbortController().signal, { networkApproved: false, unsandboxedApproved: false });
  assert.equal(missing.ok, false);

  await toolByName(tools, 'CronCreate').run(
    { schedule: '0 9 * * *', prompt: 'x', recurring: false },
    new AbortController().signal,
    { networkApproved: false, unsandboxedApproved: false },
  );
  const hit = await del.run({ jobId: 'job_1' }, new AbortController().signal, { networkApproved: false, unsandboxedApproved: false });
  assert.equal(hit.ok, true);
  const deleted = hit.cronDeleted;
  assert.ok(deleted !== undefined);
  assert.equal(deleted.jobId, 'job_1');
  assert.ok(deleted.deletedAt > 0);
});

test('a CronCreate call lands cron.created in the log after tool.finished (ADR-140)', async () => {
  const fake = fakeCron();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'CronCreate', input: { schedule: '*/5 * * * *', prompt: 'poll', recurring: true } } }],
    [{ type: 'text', text: 'scheduled' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_cron');
  const cronTools = createCronTools({ cron: fake.port });
  const deps = turnDeps(session, model, {
    tools: new Map(cronTools.map((t) => [t.spec.name, t])),
    approve: async () => 'once',
  });
  await runTurn(deps, 'keep an eye on it', new AbortController().signal);

  const created = store.events.find((event) => event.type === 'cron.created');
  if (created?.type !== 'cron.created') assert.fail('expected a cron.created event');
  assert.equal(created.jobId, 'job_1');
  assert.equal(created.prompt, 'poll');
  assert.equal(created.recurring, true);
  assert.ok(created.expiresAt !== null, 'recurring jobs carry the 7-day expiry');

  // The call succeeded first; the job exists after that (the background handoff rule).
  const finishedAt = store.events.findIndex((event) => event.type === 'tool.finished');
  const createdAt = store.events.findIndex((event) => event.type === 'cron.created');
  assert.ok(createdAt > finishedAt);
});

test('a CronDelete call lands cron.deleted by model in the log (ADR-140)', async () => {
  const fake = fakeCron();
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'CronCreate', input: { schedule: '0 9 * * *', prompt: 'poll', recurring: false } } }],
    [{ type: 'tool_call', call: { callId: 'c2', name: 'CronDelete', input: { jobId: 'job_1' } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_cron2');
  const cronTools = createCronTools({ cron: fake.port });
  const deps = turnDeps(session, model, {
    tools: new Map(cronTools.map((t) => [t.spec.name, t])),
    approve: async () => 'once',
  });
  await runTurn(deps, 'then cancel it', new AbortController().signal);

  const deleted = store.events.find((event) => event.type === 'cron.deleted');
  if (deleted?.type !== 'cron.deleted') assert.fail('expected a cron.deleted event');
  assert.equal(deleted.jobId, 'job_1');
  assert.equal(deleted.by, 'model');
});

const src = (kind: ConfigSource['kind'], body: unknown, path = `/${kind}/cowcat.json`): ConfigSource => ({
  kind,
  path,
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

test('cron.enabled resolves from the user layer only (ADR-143 ④)', () => {
  const ok = loadConfig([src('user', { cron: { enabled: false } })]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.config.cron, { enabled: false });

  for (const kind of ['project', 'session'] as const) {
    const dropped = loadConfig([
      src('user', {}),
      src(kind, { cron: { enabled: false } }, kind === 'session' ? '<session>' : undefined),
    ]);
    assert.ok(dropped.ok);
    assert.equal(dropped.config.cron, undefined, `${kind} must not be able to disable or enable cron`);
    assert.ok(dropped.warnings.some((w) => w.problem.includes('cron') && w.problem.includes('ADR-143')));
  }

  const absent = loadConfig([src('user', {})]);
  assert.ok(absent.ok);
  assert.equal(absent.config.cron, undefined, 'absent means on (default)');
});
