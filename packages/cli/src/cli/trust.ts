import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { EXIT } from './exit.js';
import { flagOn } from './flags.js';
import { statePaths } from './host.js';
import type { CommandContext } from './spec.js';

/**
 * `cowcat trust [dir]`: put a directory on the trust list, or take it off.
 *
 * Trust gates two things (ADR-028, ADR-030): the project layer's `allow` rules and
 * whether the workspace's instruction files are injected at all. Until this verb existed
 * the store had a writer (`FileTrustStore.add`) but no caller, so a normal install could
 * never leave the untrusted state: every repository's `cowcat.json` was inert and every
 * `AGENTS.md` was skipped — silently, because the skip only ever reached `TurnNote`.
 *
 * The unit is the directory itself, never its subtree (ADR-028's measured semantics), so
 * the output says which directory was recorded rather than implying a tree.
 */
export async function runTrust(context: CommandContext): Promise<number> {
  const wantList = flagOn(context.flags, 'list');
  const wantRemove = flagOn(context.flags, 'remove');
  if (wantList && wantRemove) {
    context.stderr('cowcat trust: --list 和 --remove 只能选一个');
    return EXIT.usage;
  }

  const core = await import('@corescense/cowcat-core');
  const paths = await statePaths();
  const fs = new core.NodeFs();
  const store = new core.FileTrustStore({ file: paths.trustFile, fs });
  const target = context.args[0] ?? process.cwd();

  const before = await store.load();
  if (before.problem !== null) context.stderr(`注意：${before.problem}`);

  if (wantList) {
    if (before.trusted.length === 0) {
      context.stdout(`还没有信任任何目录（${paths.trustFile}）`);
      context.stdout('信任一个目录：cowcat trust <dir>（默认当前目录）');
      return EXIT.ok;
    }
    for (const entry of before.trusted) context.stdout(entry);
    return EXIT.ok;
  }

  if (wantRemove) {
    const removed = await store.remove(target);
    context.stdout(removed ? `已撤销信任：${fs.canonical(target)}` : `本来就没有信任：${fs.canonical(target)}`);
    return EXIT.ok;
  }

  const already = core.isTrusted(before.trusted, target, fs);
  try {
    await store.add(target);
  } catch (error) {
    context.stderr(`cowcat trust: 写入失败：${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  }
  const canonical = fs.canonical(target);
  context.stdout(already ? `已经信任过：${canonical}` : `已信任：${canonical}`);
  context.stdout('（信任按目录精确匹配，子目录需要分别信任；ADR-028）');

  // What the next session will actually do differently. Read the chain with the same
  // port `doctor` uses, so this line cannot disagree with what a session loads.
  const chain = await new core.FileInstructionSource({ fs }).chain(target, {
    global: join(paths.dir, core.GLOBAL_INSTRUCTION_FILENAME),
  });
  const decided = core.decideInstruction(chain, { trusted: true });
  if (decided.kind === 'injected') {
    context.stdout(`接下来会注入：${decided.files.map((file) => basename(file.path)).join(', ')}`);
    for (const file of decided.files) context.stdout(`  ${file.path}`);
    for (const omitted of decided.omitted) context.stdout(`  超出预算未注入：${omitted.path}`);
    if (decided.truncated !== null) context.stdout(`  超出预算已截断：${decided.truncated.path}`);
  } else {
    context.stdout('这个目录下没有 AGENTS.md / CLAUDE.md，指令链为空。');
  }
  // Skills gate on the same trust (ADR-114 ③); a session that just saw "skipped N skills"
  // runs `cowcat trust` expecting the list to change, so say what will load.
  const discovered = await new core.FileSkills({ fs, home: homedir() }).discover(target);
  const unlocked = core.decideSkills(discovered.skills, { trusted: true });
  if (unlocked.kind === 'injected' && unlocked.skipped.length === 0) {
    context.stdout(`接下来会加载 ${String(unlocked.skills.length)} 个技能：${unlocked.skills.map((skill) => skill.name).join(', ')}`);
  }
  context.stdout(`项目层配置（${basename(paths.projectConfig)}）的 allow 从下一次会话起生效。`);
  return EXIT.ok;
}
