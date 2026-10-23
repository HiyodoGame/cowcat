import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT } from './exit.js';
import { flagValue } from './flags.js';
import { statePaths } from './host.js';
import { COMMANDS, type CommandContext } from './spec.js';
import { readVersion } from './version.js';

/**
 * This package's Node floor is the kernel's: 22.
 *
 * ADR-062 ③ rejected option B because it "would bind `serve` to the renderer's Node
 * floor", and that is exactly what a >=26 floor on the BIN does — the headless server,
 * the one-shot verb and `doctor` all work on 22, and only the `tui` verb needs opentui.
 * So the floor is this package's own, and the renderer's is checked where it is loaded
 * (`cowcat tui`, T7) and reported as its own row here (ADR-065 ①).
 */
const MIN_NODE = { major: 22, minor: 0 } as const;
/** opentui's floor (ADR-056), for the one verb that loads a renderer. */
const RENDERER_NODE = { major: 26, minor: 4 } as const;

/**
 * `cowcat doctor`.
 *
 * It reports what this build can actually check, and until T4a that was a short list —
 * configuration and the sandbox needed the kernel. Now they do not, so the rows are: the
 * runtime, the renderer's native core, the protocol generation, which config files were
 * read (and what was refused), whether THIS directory is trusted, how many rules that
 * leaves, the sandbox profile plus what the machine really supports, and the model
 * selection — without ever printing a key.
 *
 * "No model configured" is reported as a state, not a failure (ADR-064 ⑥): sessions,
 * `serve` and this verb all work without one, and a `FAIL` on a fresh install would teach
 * people to ignore the exit code.
 */
export async function runDoctor(context: CommandContext): Promise<number> {
  let failed = 0;
  const row = (label: string, value: string, ok: boolean): void => {
    context.stdout(`  ${label.padEnd(10)}${value.padEnd(52)}${ok ? 'ok' : 'FAIL'}`);
    if (!ok) failed += 1;
  };
  const note = (label: string, value: string): void => {
    context.stdout(`  ${label.padEnd(10)}${value}`);
  };
  const line = (text: string): void => {
    context.stdout(`  ${' '.repeat(10)}${text}`);
  };

  context.stdout(`cowcat ${readVersion()} doctor`);

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const meets = (required: { readonly major: number; readonly minor: number }): boolean =>
    major > required.major || (major === required.major && minor >= required.minor);

  // Two rows rather than one: "this build runs" and "the TUI would run here" are
  // different questions, and answering them with one FAIL is how people learn to ignore
  // the exit code.
  row('node', `v${process.versions.node}（需要 >=${String(MIN_NODE.major)}）`, meets(MIN_NODE));

  // What this build does NOT check: the renderer's native core. It lives in
  // `packages/tui`'s own `node_modules` (a `file:` dependency is a junction, so npm does
  // not install the target's dependencies — ADR-062), which means a probe from here would
  // report a false FAIL. The floor is a fact this process can check, so it is reported;
  // the binary itself is checked by `packages/tui/test/render.test.ts` and, from T7, when
  // the `tui` verb starts.
  const rendererOk = meets(RENDERER_NODE);
  note(
    '渲染器',
    rendererOk
      ? `v${String(RENDERER_NODE.major)}.${String(RENDERER_NODE.minor)} 起可用（TUI 的 opentui 门槛，ADR-056）`
      : `TUI 需要 >=${String(RENDERER_NODE.major)}.${String(RENDERER_NODE.minor)}（opentui 的门槛）；serve/run/doctor 不受影响`,
  );

  const { PROTOCOL_VERSION } = await import('@corescense/cowcat-protocol');
  row('protocol', `version ${String(PROTOCOL_VERSION)}`, true);

  await reportKernel(context, row, note, line);

  for (const command of COMMANDS) {
    if (command.status === 'blocked') line(`${command.name.padEnd(10)}尚未接线：${command.blockedBy}`);
  }

  context.stdout(failed === 0 ? 'doctor: 通过' : `doctor: ${String(failed)} 项失败`);
  return failed === 0 ? EXIT.ok : EXIT.failed;
}

type Row = (label: string, value: string, ok: boolean) => void;
type Note = (label: string, value: string) => void;
type Line = (text: string) => void;

/** The rows that need the kernel. One dynamic import, so `--help` never pays for it. */
async function reportKernel(context: CommandContext, row: Row, note: Note, line: Line): Promise<void> {
  const {
    FileInstructionSource,
    FileSkills,
    FileTrustStore,
    GLOBAL_INSTRUCTION_FILENAME,
    ModelConfigError,
    NodeFs,
    decideInstruction,
    decideSkills,
    describeInstructionSkip,
    describeSkillSkip,
    isTrusted,
    loadHookSources,
    loadHostConfig,
    nodePlatform,
    projectRootOf,
    resolveSandboxProfile,
    selectModel,
    skillCatalogBudget,
    trustedRules,
    withHostRules,
  } = await import('@corescense/cowcat-core');

  const cwd = process.cwd();
  const home = homedir();
  const paths = await statePaths();
  const fs = new NodeFs();
  const projectRoot = projectRootOf(fs, cwd);
  const configPath = flagValue(context.flags, 'config');
  note('状态目录', paths.dir);

  /** Whether the project root's .gitignore already admits `path` (exact or parent line). */
  const gitignoreCovers = (path: string): boolean => {
    if (projectRoot === null) return true;
    let text: string;
    try {
      text = readFileSync(join(projectRoot, '.gitignore'), 'utf8');
    } catch {
      return false;
    }
    const needle = path.replace(/\\/g, '/');
    const covered = (line: string): boolean => {
      const pattern = line.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (pattern === '' || pattern.startsWith('#') || pattern.startsWith('!')) return false;
      return pattern === needle || pattern === `${needle}/` || needle.startsWith(`${pattern}/`);
    };
    return text.split('\n').some(covered);
  };

  const loaded = await loadHostConfig({
    cwd,
    home,
    paths,
    ...(configPath === null ? {} : { sessionConfigPath: configPath }),
  });
  if (!loaded.ok) {
    // Everything below needs a usable config, so there is nothing honest to report after
    // a refusal — the refusal IS the report.
    for (const problem of loaded.errors) row('配置', `${problem.source}: ${problem.problem}`, false);
    return;
  }
  row(
    '配置',
    loaded.files.length === 0
      ? '没有配置文件，用内置默认值'
      : `${String(loaded.files.length)} 层：${loaded.files.join('  ')}`,
    true,
  );
  for (const warning of loaded.warnings) line(`警告：${warning.source}: ${warning.problem}`);

  const trust = await new FileTrustStore({ file: paths.trustFile, fs }).load();
  const trusted = isTrusted(trust.trusted, cwd, fs);
  note(
    'trust',
    trusted
      ? `${cwd} 已信任（项目层的 allow 生效）`
      : `${cwd} 未受信（项目层的 allow 不生效，deny/ask 照常，ADR-028）`,
  );
  if (trust.problem !== null) line(`注意：${trust.problem}`);

  // The rules a session actually runs with — the config's (project `allow` gated by
  // trust) plus the composition root's own baseline, not the config's alone.
  note('rules', `${String(withHostRules(trustedRules(loaded.config, { trusted })).length)} 条（含组合根的 TodoWrite 免问基线）`);

  // What the model would be told about this repository (ADR-075~078). Reported here
  // because "it did not follow AGENTS.md" is unanswerable without seeing what loaded —
  // and because a skip is the one outcome that has to be loud.
  const chain = await new FileInstructionSource({ fs }).chain(cwd, { global: join(paths.dir, GLOBAL_INSTRUCTION_FILENAME) });
  const instructions = decideInstruction(chain, { trusted });
  if (instructions.kind === 'injected') {
    note('instr', `${String(instructions.files.length)} 份：${instructions.files.map((file) => basename(file.path)).join(', ')}`);
    for (const file of instructions.files) line(`  ${file.path}`);
    for (const omitted of instructions.omitted) line(`超出预算未注入：${omitted.path}`);
    if (instructions.truncated !== null) line(`超出预算已截断：${instructions.truncated.path}`);
  } else if (instructions.kind === 'skipped-untrusted') {
    note('instr', describeInstructionSkip(instructions) ?? '未注入');
  } else {
    // `none` also covers "there is an AGENTS.md and it is empty" — `FileInstructionSource`
    // drops empty files before the decision sees them — so claiming there is no file would
    // be the one kind of mistake this row exists to prevent.
    note('instr', '（没有可注入的 AGENTS.md / CLAUDE.md：不存在或为空）');
  }

  // What skills the model would be offered (ADR-114~117). The row exists because the two
  // silent failure modes — a project skill withheld by trust, and a frontmatter field that
  // looks like a grant but is not honoured — are invisible from inside a turn.
  //
  // The budget is the one a real session would use (ADR-116 ②), not the 8 KB default:
  // with a 128k window the live budget is 2%, and reporting the default would describe a
  // catalog the model will never see.
  let skillWindow: number | undefined;
  try {
    skillWindow = selectModel(loaded.config.model).preset.limits.context;
  } catch {
    // No usable model: a session would refuse before the catalog matters, and the default
    // budget is the honest thing to report.
  }
  const skillDiscovery = await new FileSkills({ fs, home }).discover(cwd);
  const skills = decideSkills(skillDiscovery.skills, { trusted }, skillCatalogBudget(skillWindow));
  if (skills.kind === 'injected') {
    const bytes = Buffer.byteLength(skills.catalog.text, 'utf8');
    const skipped = skills.skipped.length === 0 ? '' : `，未受信跳过 ${String(skills.skipped.length)} 个`;
    note('skills', `${String(skills.skills.length)} 个，catalog ${String(bytes)} 字节（预算 ${String(skillCatalogBudget(skillWindow))}）${skipped}`);
    for (const skill of skills.skills) line(`  ${skill.name}（${skill.layer}/${skill.origin}）← ${skill.path}`);
    for (const shadowed of skills.shadowed) line(`同名覆盖：${shadowed.loser.path} → ${shadowed.winner.path}`);
    for (const skill of skills.skills) {
      if (skill.ignoredFields.length > 0) line(`未生效字段（${skill.name}）：${skill.ignoredFields.join(', ')}`);
    }
    if (skills.catalog.omitted > 0) line(`预算内放不下全部名字，略过 ${String(skills.catalog.omitted)} 个`);
  } else if (skills.kind === 'skipped-untrusted') {
    note('skills', describeSkillSkip(skills.skills) ?? '未加载');
  } else if (skillDiscovery.skills.length > 0) {
    note('skills', `${String(skillDiscovery.skills.length)} 个全部被 disable-model-invocation 隐藏`);
  } else {
    note('skills', '（没有发现 SKILL.md）');
  }
  for (const warning of skillDiscovery.warnings) line(`跳过：${warning}`);

  // Hooks (ADR-121/123): discovered the same way the host discovers them — doctor does
  // not run handlers, it reports what would run and what is parsed but inert.
  const hookSources = await loadHookSources({
    home,
    cowcatDir: paths.dir,
    projectRoot,
    trusted,
  });
  const hookCount = hookSources.parsed.hooks.length;
  const hookSkipped = hookSources.skippedUntrusted;
  note(
    'hooks',
    hookCount === 0 && hookSkipped === 0
      ? '（没有配置）'
      : `${String(hookCount)} 个 handler（${String(hookSources.loaded)} 个文件）${hookSkipped === 0 ? '' : `，未受信跳过 ${String(hookSkipped)} 个 project 文件`}；doctor 不执行 hook`,
  );
  for (const hook of hookSources.parsed.hooks) {
    line(`  ${hook.event}${hook.matcher === null ? '' : ` (${hook.matcher.kind === 'regex' ? hook.matcher.pattern : hook.matcher.kind === 'exact' ? hook.matcher.names.join('|') : '*'})`} ← ${hook.source}`);
  }
  for (const item of hookSources.parsed.inert) line(`  ${item}`);

  const mcpServers = Object.entries(loaded.config.mcp.servers);
  if (mcpServers.length === 0) {
    note('mcp', '未配置服务器');
  } else {
    const runnable = mcpServers.filter(([, entry]) => entry.origin !== 'project' || trusted);
    const skipped = mcpServers.length - runnable.length;
    note(
      'mcp',
      `${String(runnable.length)} 个：${runnable.map(([name]) => name).join(', ')}${skipped === 0 ? '' : `（未受信跳过 ${String(skipped)} 个）`}；doctor 不启动服务器`,
    );
  }

  const sandbox = resolveSandboxProfile(loaded.config.sandbox, { cwd, home, fs });
  note('sandbox', `mode ${sandbox.profile.mode} / backend ${sandbox.profile.backend} / network ${sandbox.profile.network}`);
  for (const limitation of sandbox.profile.limitations) line(`未被采纳：${limitation}`);

  // Worktree sessions live under .cowcat/worktrees/ (ADR-144); an un-ignored directory
  // there shows up as an embedded-repo hint on every `git add`, which is the measured
  // annoyance this line exists to prevent.
  if (projectRoot !== null && !gitignoreCovers('.cowcat/worktrees')) {
    note('worktree', '建议把 .cowcat/worktrees/ 写进 .gitignore（--worktree 的会话树，避免嵌套仓库提示）');
  }

  const verdicts = nodePlatform({ env: process.env }).sandboxBackends();
  const usable = verdicts.filter((verdict) => verdict.usable).map((verdict) => verdict.name);
  if (sandbox.profile.mode === 'system') {
    // Only here is a missing backend a failure: in `light` the OS-level tier is not asked
    // for, and calling its absence a FAIL would be inventing a requirement.
    row('后端', usable.length === 0 ? `没有可用后端：${describeVerdicts(verdicts)}` : `可用：${usable.join(', ')}`, usable.length > 0);
    // And only here is the fix relevant — telling someone how to install bubblewrap when
    // they never asked for the system tier is noise, not help.
    for (const verdict of verdicts) {
      if (!verdict.usable && verdict.fix !== null) line(`修法（${verdict.name}）：${verdict.fix}`);
    }
  } else {
    note('后端', `档位 ${sandbox.profile.mode} 不需要 OS 级沙箱；本机可用：${usable.length === 0 ? '无' : usable.join(', ')}`);
  }

  try {
    const selection = selectModel(loaded.config.model);
    note('模型', `${selection.id}（${selection.preset.protocol} → ${selection.baseUrl ?? 'SDK 默认端点'}）`);
    for (const warning of selection.warnings) line(`注意：${warning}`);
    // The key's PRESENCE is checked and its value is never read into a string that could
    // be printed (ADR-063 D3, ADR-089).
    if (selection.apiKey !== null) {
      note('key', 'v1 内联 apiKey（仅在内存中使用，不会写回；建议改用 apiKeyEnv + 环境变量）');
    } else if (selection.apiKeyEnv !== null) {
      const present = (process.env[selection.apiKeyEnv] ?? '') !== '';
      row('key', `${selection.apiKeyEnv} ${present ? '已设置' : '未设置（发不出请求）'}`, present);
    } else {
      row('key', '没有可用的密钥来源', false);
    }
  } catch (error) {
    if (error instanceof ModelConfigError) {
      note('模型', `未配置（${error.problem}）—— 一次回合需要 model.preset`);
      if (error.hint !== null) line(error.hint);
    } else {
      row('模型', error instanceof Error ? error.message : String(error), false);
    }
  }
}

function describeVerdicts(verdicts: readonly { readonly name: string; readonly reason: string }[]): string {
  return verdicts.length === 0 ? '这台机器上没有可探测的后端' : verdicts.map((v) => `${v.name}(${v.reason})`).join(', ');
}
