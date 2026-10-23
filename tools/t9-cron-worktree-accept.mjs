#!/usr/bin/env node
/**
 * T9 真机验收：Cron/Worktree（调研 #202 §7 T9）。
 *
 * 两条腿，都在隔离的临时状态目录里跑（不写真实 ~/.cowcat）：
 *
 *  Cron：真 glm 经协议客户端让模型自然 CronCreate 建任务 → 宿主心跳 fired →
 *        cron 回合无人值守运行（Write 询问被 by:'unattended' 拒绝）→ 面板
 *        cron.list / cron.remove 全链。一次性任务 fire 后投影自删。
 *  Worktree：真 git 仓库 → ensureWorktree（信任继承）→ 宿主 cwd=worktree +
 *        extraPaths 放行主检出 .git → 会话内 Write + git commit 经审批执行 →
 *        提交落在 worktree 分支上、主检出可见。
 *
 * 用法：ZHIPU_API_KEY 在环境里时 `node tools/t9-cron-worktree-accept.mjs`
 * 退出码：0 全过；1 有断言失败（日志给出是哪条）；2 前提缺失（无 key/无构建/git）。
 *
 * 它会花真实模型请求（约 4-6 个回合），密钥只经环境传递，绝不打印。
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const coreDist = join(here, '..', 'packages', 'cowcat', 'dist', 'src', 'index.js');
const protoDist = join(here, '..', 'packages', 'protocol', 'dist', 'src', 'index.js');

if (!existsSync(coreDist) || !existsSync(protoDist)) {
  console.error('no build to run against; build cowcat and protocol first.');
  process.exit(2);
}
if (!process.env.ZHIPU_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  console.error('neither ZHIPU_API_KEY nor DEEPSEEK_API_KEY is set in this environment: the cron leg spends real requests.');
  process.exit(2);
}

const core = await import(pathToFileURL(coreDist).href);
const protocol = await import(pathToFileURL(protoDist).href);

const state = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-t9-state-')));
const home = join(state, 'home');
const proj = join(state, 'proj');
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });
// 隔离的用户配置：自定义 preset 走内置 deepseek provider（密钥只从环境读）。
// 自定义而非内置 deepseek/deepseek-flash：catalogue 的 output 上限是未实测数字，
// 真机驱动用保守值（HANDOFF 教训：catalogue 数字必须实测）。
mkdirSync(join(state, '.cowcat'), { recursive: true });
writeFileSync(
  join(state, '.cowcat', 'config.json'),
  `${JSON.stringify({
    model: {
      preset: 'deepseek/t9-flash',
      presets: {
        'deepseek/t9-flash': { protocol: 'openai', model: 'deepseek-flash', limits: { output: 8192, context: 128000 }, toolCalls: true },
      },
    },
  })}\n`,
);

const cleanup = () => rmSync(state, { recursive: true, force: true });
process.on('exit', cleanup);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

async function until(what, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** 超时/失败的诊断：事件类型流 + 每条 tool.finished 的输出头。 */
function dumpEvents(fx) {
  console.log('  --- event dump ---');
  for (const event of fx.events) {
    const parts = [`${String(event.seq ?? '?')} ${event.type}`];
    if (event.type === 'tool.finished') {
      parts.push(String(fx.field(event, 'name')), `ok=${String(fx.field(event, 'ok'))}`, String(fx.field(event, 'output')).slice(0, 100).replace(/\n/g, ' '));
    }
    if (event.type === 'turn.transitioned') parts.push(String(fx.field(event, 'to')), String(fx.field(event, 'reason')));
    if (event.type === 'approval.requested') parts.push(String(fx.field(event, 'callId')), String(fx.field(event, 'name')));
    console.log(`  ${parts.join(' | ')}`);
  }
}

async function startHost(cwd, extraPaths) {
  const host = await core.createHost({
    cwd,
    home,
    env: process.env,
    version: '0.0.0-t9',
    paths: core.cowcatPaths({ cwd, home, dir: join(state, '.cowcat') }),
    approvalTimeoutMs: 60_000,
    ...(extraPaths === undefined ? {} : { extraWritePaths: extraPaths, extraReadPaths: extraPaths }),
  });
  const pair = protocol.memoryTransport();
  const server = protocol.createServer({ host, transport: pair.server });
  const client = protocol.createClient({ transport: pair.client });
  const events = [];
  client.on('event', (event) => events.push(event));
  const field = (event, name) => (event === undefined ? undefined : Reflect.get(event, name));
  // 橡皮图章用户：每个审批都答 once（cron 回合的询问走 unattended，到不了这里）。
  const answered = new Set();
  const stamp = setInterval(() => {
    for (const event of events) {
      if (event.type !== 'approval.requested') continue;
      const callId = field(event, 'callId');
      if (typeof callId !== 'string' || answered.has(callId)) continue;
      answered.add(callId);
      for (const session of sessions) {
        void client.respondApproval(session, callId, 'once').catch(() => undefined);
      }
    }
  }, 200);
  const sessions = [];
  return {
    host,
    client,
    events,
    field,
    track: (id) => sessions.push(id),
    close: async () => {
      clearInterval(stamp);
      client.close();
      await server.closed;
      await host.close();
    },
  };
}

// ── Cron 腿 ──────────────────────────────────────────────────────────────────────
console.log('\n== Cron 腿：真模型 CronCreate → fired → 无人值守回合 ==');
{
  const fx = await startHost(proj);
  try {
    await fx.client.initialize();
    const sessionId = 'sess_t9_cron';
    await fx.client.createSession(sessionId);
    fx.track(sessionId);
    await fx.client.openSession(sessionId);

    const setup = fx.client.sendTurn(
      sessionId,
      '用 CronCreate 建一个一次性定时任务：schedule 写 "* * * * *"，prompt 写 "用 Write 工具创建文件 cron-status.txt，内容写 fired；然后只回答一句话报告结果。"。建好以后用一句话告诉我 jobId。',
    );
    try {
      await until('the model to create the job (cron.created)', () => fx.events.some((e) => e.type === 'cron.created'), 120_000);
    } catch (error) {
      dumpEvents(fx);
      throw error;
    }
    await setup.catch(() => undefined);
    check('模型自然调用 CronCreate（cron.created 落日志）', fx.events.some((e) => e.type === 'cron.created'));

    // 面板读侧：此刻应有一个活的一次性作业。
    const jobs = await fx.client.listCronJobs(sessionId);
    check('cron.list 返回 1 个一次性作业', jobs.length === 1 && jobs[0].recurring === false, JSON.stringify(jobs.map((j) => j.jobId)));

    // 等心跳 fire（下一分钟边界，至多 ~65s）。
    await until('the cron fire', () => fx.events.some((e) => e.type === 'cron.fired'), 90_000);
    const fired = fx.events.find((e) => e.type === 'cron.fired');
    await until('the cron turn to open', () => fx.events.some((e) => e.type === 'turn.opened' && fx.field(e, 'turnId') === fx.field(fired, 'turnId')));
    const opened = fx.events.find((e) => e.type === 'turn.opened' && fx.field(e, 'turnId') === fx.field(fired, 'turnId'));
    check('fired 点名的回合如实打开（turnId 一致）', fx.field(opened, 'turnId') === fx.field(fired, 'turnId'));
    await until('the cron turn to complete', () =>
      fx.events.some((e) => e.type === 'turn.transitioned' && fx.field(e, 'to') === 'completed' && fx.field(e, 'turnId') === fx.field(fired, 'turnId')),
    );

    const writeFinished = fx.events.find((e) => e.type === 'tool.finished' && fx.field(e, 'name') === 'Write');
    const unattendedAnswer = fx.events.find(
      (e) => e.type === 'approval.answered' && fx.field(e, 'by') === 'unattended',
    );
    check('cron 回合的 Write 被无人值守拒绝（by:unattended 留审计）',
      writeFinished !== undefined && fx.field(writeFinished, 'ok') === false && unattendedAnswer !== undefined,
      writeFinished === undefined ? 'cron 回合没有发起 Write' : `output=${String(fx.field(writeFinished, 'output')).slice(0, 80)}`,
    );
    const writeAsked = fx.events.some(
      (e) => e.type === 'approval.requested' && fx.field(e, 'callId') === fx.field(writeFinished, 'callId'),
    );
    check('该询问没有挂起等用户（有记录无等待）', writeAsked === true, 'approval.requested 应存在但由 unattended 立即回答');

    // 一次性 fire 即终态：投影自删（轮询 listCronJobs）。
    {
      const deadline = Date.now() + 15_000;
      for (;;) {
        if ((await fx.client.listCronJobs(sessionId)).length === 0) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for the one-shot to drop itself');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      check('一次性任务 fire 后投影自删（list 为空）', true);
    }

    // 用户删除路径：再建一个周期任务，面板删除，日志写 by:user。
    const setup2 = fx.client.sendTurn(sessionId, '再建一个周期任务：schedule "*/5 * * * *"，prompt "巡检"，recurring true。建好一句话确认。');
    await until('the recurring job', () => fx.events.some((e) => e.type === 'cron.created' && fx.field(e, 'recurring') === true), 120_000);
    await setup2.catch(() => undefined);
    const recurring = (await fx.client.listCronJobs(sessionId))[0];
    check('周期作业带 nextRun 与 7 天过期', recurring !== undefined && recurring.nextRun !== null && recurring.expiresAt !== null);
    if (recurring !== undefined) {
      const removed = await fx.client.removeCronJob(sessionId, recurring.jobId);
      const deleted = fx.events.find((e) => e.type === 'cron.deleted');
      check('cron.remove 真删且日志记 by:user', removed === true && fx.field(deleted, 'by') === 'user');
    }
  } finally {
    await fx.close();
  }
}

// ── Worktree 腿 ──────────────────────────────────────────────────────────────────
console.log('\n== Worktree 腿：真 git 建树 → 会话落提交 ==');
{
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-t9-main-')));
  process.on('exit', () => rmSync(main, { recursive: true, force: true }));
  git(['init', '-b', 'main'], main);
  git(['config', 'user.email', 't9@example.com'], main);
  git(['config', 'user.name', 't9'], main);
  writeFileSync(join(main, 'README.md'), 't9\n');
  git(['add', '.'], main);
  git(['commit', '-m', 'init'], main);
  // 模拟用户已 cowcat trust 过主检出。
  writeFileSync(join(state, '.cowcat', 'trust.json'), `${JSON.stringify({ trusted: [main] })}\n`);

  const fs = new core.NodeFs();
  const platform = new core.NodePlatform({ env: process.env });
  const processPort = new core.NodeProcess({
    platform,
    sandboxCommand: core.createSandboxExecutor({ platform, fsProbe: core.fsProbeFrom(fs) }),
  });
  const wt = await core.ensureWorktree({
    process: processPort,
    fs,
    trust: new core.FileTrustStore({ file: join(state, '.cowcat', 'trust.json'), fs }),
    mainCwd: main,
  }, 't9');
  check('ensureWorktree 真机成功', wt.ok === true, wt.ok === false ? wt.error : '');
  if (!wt.ok) throw new Error('worktree leg cannot continue');

  const trustRecord = JSON.parse(readFileSync(join(state, '.cowcat', 'trust.json'), 'utf8'));
  check('信任显式继承进 trust 记录（ADR-145）', (trustRecord.trusted ?? []).includes(wt.worktree.path));

  const fx = await startHost(wt.worktree.path, [wt.worktree.mainGitDir]);
  try {
    await fx.client.initialize();
    const sessionId = 'sess_t9_wt';
    await fx.client.createSession(sessionId);
    fx.track(sessionId);
    await fx.client.openSession(sessionId);
    // ADR-126：cwd 在会话头事件里（session.open 应答按设计不带 cwd——它走 session.list 的摘要）。
    const header = fx.events.find((e) => e.type === 'session.opened');
    check('会话头 cwd 是 worktree（ADR-126/144）', fx.field(header, 'cwd') === wt.worktree.path, String(fx.field(header, 'cwd')));
    const summary = (await fx.client.listSessions()).find((entry) => entry.sessionId === sessionId);
    check('session.list 摘要的 cwd 同为 worktree', summary?.cwd === wt.worktree.path);

    const send = fx.client.sendTurn(
      sessionId,
      '两步：1) 用 Write 创建 hello.txt，内容写 "from worktree session"；2) 用 Bash 执行 git add hello.txt 再 git commit -m "worktree session commit"。最后只回答一句话报告提交是否成功。',
    );
    await until('the turn to complete', () =>
      fx.events.some((e) => e.type === 'turn.transitioned' && fx.field(e, 'to') === 'completed' && fx.field(e, 'turnId') !== null),
    180_000,
    );
    await send.catch(() => undefined);

    const bashFinished = fx.events.find((e) => e.type === 'tool.finished' && fx.field(e, 'name') === 'Bash');
    check('worktree 内 git commit 经审批执行成功（沙箱放行主检出 .git，ADR-147）',
      bashFinished !== undefined && fx.field(bashFinished, 'ok') === true,
      bashFinished === undefined ? '没有 Bash 调用' : String(fx.field(bashFinished, 'output')).slice(0, 120),
    );
    const branchLog = git(['log', '--oneline', 'worktree-t9'], main).trim();
    check('提交落在 worktree 分支且主检出可见', branchLog.includes('worktree session commit'), branchLog.split('\n')[0]);
    check('文件写在 worktree 目录', existsSync(join(wt.worktree.path, 'hello.txt')));
  } finally {
    await fx.close();
  }
}

console.log(failures === 0 ? '\nT9 真机验收全过' : `\nT9 有 ${String(failures)} 条失败`);
process.exit(failures === 0 ? 0 : 1);
