import { homedir } from 'node:os';
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
    FileTrustStore,
    ModelConfigError,
    NodeFs,
    decideInstruction,
    describeInstructionSkip,
    isTrusted,
    loadHostConfig,
    nodePlatform,
    resolveSandboxProfile,
    selectModel,
    trustedRules,
    withHostRules,
  } = await import('@corescense/cowcat-core');

  const cwd = process.cwd();
  const home = homedir();
  const paths = await statePaths();
  const fs = new NodeFs();
  const configPath = flagValue(context.flags, 'config');
  note('状态目录', paths.dir);

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
  const chain = await new FileInstructionSource({ fs }).chain(cwd, { global: join(paths.dir, 'AGENTS.md') });
  const instructions = decideInstruction(chain, { trusted });
  if (instructions.kind === 'injected') {
    note('instr', `${String(instructions.files.length)} 份：${instructions.files.map((file) => basename(file.path)).join(', ')}`);
    for (const file of instructions.files) line(`  ${file.path}`);
    for (const omitted of instructions.omitted) line(`超出预算未注入：${omitted.path}`);
    if (instructions.truncated !== null) line(`超出预算已截断：${instructions.truncated.path}`);
  } else if (instructions.kind === 'skipped-untrusted') {
    note('instr', describeInstructionSkip(instructions) ?? '未注入');
  } else {
    note('instr', '（这个目录往上没有 AGENTS.md / CLAUDE.md）');
  }

  const sandbox = resolveSandboxProfile(loaded.config.sandbox, { cwd, home, fs });
  note('sandbox', `mode ${sandbox.profile.mode} / backend ${sandbox.profile.backend} / network ${sandbox.profile.network}`);
  for (const limitation of sandbox.profile.limitations) line(`未被采纳：${limitation}`);

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
    // be printed (ADR-063 D3).
    const present = (process.env[selection.apiKeyEnv] ?? '') !== '';
    row('key', `${selection.apiKeyEnv} ${present ? '已设置' : '未设置（发不出请求）'}`, present);
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
