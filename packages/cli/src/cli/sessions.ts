import { EXIT } from './exit.js';
import { statePaths } from './host.js';
import type { CommandContext } from './spec.js';

/**
 * `cowcat sessions list | resume <id>`.
 *
 * `list` reads the session directory directly instead of building a host, and that is not
 * an optimisation: a broken config file is one of the reasons to run this verb, and
 * making it depend on the config would be exactly backwards. The rows are the session
 * ids and their event counts, which is what `--session <id>` and `cowcat serve` both
 * take.
 *
 * `resume` is the interactive half, and it needs the TUI (T7). It stays unwired and says
 * what to use instead rather than pretending the id it was given did something.
 */
export async function runSessions(context: CommandContext): Promise<number> {
  const action = context.args[0];

  if (action === 'resume') {
    context.stderr('cowcat sessions resume: 尚未接线，需要 T7（交互式 TUI）');
    context.stderr('  现在可以：cowcat run --session <id> "<prompt>" 继续它，或 cowcat serve 交给前端');
    return EXIT.failed;
  }

  const { createSessionIndex } = await import('@corescense/cowcat-core');
  const paths = await statePaths();
  const sessions = await createSessionIndex(paths.sessionsDir).list();

  if (sessions.length === 0) {
    context.stdout(`没有会话（${paths.sessionsDir}）`);
    return EXIT.ok;
  }
  for (const session of sessions) {
    context.stdout(`${session.sessionId}\t${String(session.lastSeq)} 条事件`);
  }
  return EXIT.ok;
}
