import { EXIT } from './exit.js';
import { flagOn } from './flags.js';
import { statePaths } from './host.js';
import type { CommandContext } from './spec.js';
import { startTui } from './tui.js';

/**
 * `cowcat sessions list | resume <id>`.
 *
 * `list` reads the session directory directly instead of building a host, and that is not
 * an optimisation: a broken config file is one of the reasons to run this verb, and
 * making it depend on the config would be exactly backwards. The rows are the session
 * ids and their event counts, which is what `--session <id>` and `cowcat serve` both
 * take.
 *
 * `resume` IS the TUI with a session already chosen (T7): the same function the `tui` verb
 * calls, so the two cannot drift — and the Node floor check happens in one place, before the
 * renderer is imported.
 */
export async function runSessions(context: CommandContext): Promise<number> {
  const action = context.args[0];
  const id = context.args[1];

  if (action === 'resume') {
    if (id === undefined) {
      context.stderr('用法：cowcat sessions resume <id>');
      return EXIT.usage;
    }
    return startTui(context, id);
  }

  const { createSessionIndex } = await import('@corescense/cowcat-core');
  const paths = await statePaths();
  const sessions = await createSessionIndex(paths.sessionsDir).list();
  // Children are listed only when asked for (ADR-079 ④): they are evidence of a delegation,
  // not something a person opens by hand, and a long session with a few delegations would
  // otherwise bury the sessions that person actually started.
  const shown = flagOn(context.flags, 'all')
    ? sessions
    : sessions.filter((session) => session.parentSessionId === null);

  if (shown.length === 0) {
    context.stdout(`没有会话（${paths.sessionsDir}）`);
    return EXIT.ok;
  }
  for (const session of shown) {
    const derived = [session.title, session.cwd, session.model].filter((part) => part !== null);
    const parent =
      session.parentSessionId === null
        ? ''
        : session.parentRole === 'fork'
          ? `\tfork 自 ${session.parentSessionId}`
          : `\t子会话，父会话 ${session.parentSessionId}`;
    const suffix = derived.length === 0 ? '' : `\n  ${derived.join(' · ')}`;
    context.stdout(`${session.sessionId}\t${String(session.lastSeq)} 条事件${parent}${suffix}`);
    // The id alone is not an instruction; the measured complaint was "I don't know how to
    // resume". A copyable line costs one row per session and answers it where it is asked.
    context.stdout(`  恢复：cowcat sessions resume ${session.sessionId}`);
  }
  return EXIT.ok;
}
