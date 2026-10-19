import { EXIT } from './exit.js';
import { buildHost } from './host.js';
import type { CommandContext } from './spec.js';

/**
 * `cowcat serve`: the headless protocol service over stdio, with the REAL host behind it
 * (ADR-064).
 *
 * Two things here are easy to get wrong and both are deliberate:
 *
 *   * the host is closed in a `finally`. A kernel `Session` holds the session lock for
 *     its whole life (ADR-010), so a `serve` that returned without closing would leave a
 *     lock file behind and the next process would report "writer pid … is gone but left
 *     its lock file behind".
 *   * the protocol is imported *here*, not at the top of the module, so `--help`,
 *     `--version` and an unknown verb never load the protocol graph — and the host is
 *     built only after that, so a broken config file costs nothing on the fast paths.
 */
export async function runServe(context: CommandContext): Promise<number> {
  const { serve } = await import('@corescense/cowcat-protocol');
  const host = await buildHost(context);
  if (host === null) return EXIT.failed;

  try {
    return await serve({
      host,
      ...(context.stdin === undefined ? {} : { input: context.stdin }),
      ...(context.stdoutStream === undefined ? {} : { output: context.stdoutStream }),
      diagnostics: context.diagnostics ?? context.stderr,
    });
  } finally {
    await host.close();
  }
}
