import { fileURLToPath } from 'node:url';
import { EXIT } from './exit.js';
import { flagValue } from './flags.js';
import { buildHost } from './host.js';
import type { CommandContext } from './spec.js';
import { readVersion } from './version.js';

/**
 * `cowcat tui` — and `cowcat sessions resume <id>`, which is the same thing with a session
 * already chosen.
 *
 * ## How the interface reaches the kernel (ADR-066 ①)
 *
 * In-process, over the protocol's **memory transport**: this verb builds the real host, puts
 * a server on one end and a client on the other, and hands the client to the renderer. Two
 * consequences, both the point:
 *
 *   * `packages/tui` never sees the kernel. It is the only package that could have (the
 *     composition root is one import away), so this is where ADR-059 ③ stops being a
 *     convention — the renderer reaches the session through exactly the same port an IDE
 *     plugin would.
 *   * there is no second process to babysit: no child lifecycle, no duplicate Node start,
 *     and Ctrl-C cannot leave a `serve` behind holding the session lock.
 *
 * `cowcat serve` remains the headless entry (stdio, for editors and scripts). Connecting the
 * TUI *to* a running `serve` is a transport swap and nothing else — that is what ADR-055's
 * "protocol and transport are separate" was for, and it is not needed yet.
 *
 * ## The Node floor check (ADR-065 ①)
 *
 * This package runs on Node 22; the renderer needs 26.4. The check therefore happens HERE,
 * before the dynamic import, so an old Node gets a sentence rather than a native-module
 * failure from three frames deep.
 */
const RENDERER_FLOOR = { major: 26, minor: 4 } as const;
/** The executable this verb came in through, for a copy-pasteable workaround. */
const CLI_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));

export async function runTui(context: CommandContext): Promise<number> {
  return startTui(context, flagValue(context.flags, 'session'));
}

/** Shared by the `tui` verb and `sessions resume <id>`. */
export async function startTui(context: CommandContext, sessionId: string | null): Promise<number> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const recentEnough = major > RENDERER_FLOOR.major || (major === RENDERER_FLOOR.major && minor >= RENDERER_FLOOR.minor);
  if (!recentEnough) {
    context.stderr(
      `cowcat tui: 需要 Node >=${String(RENDERER_FLOOR.major)}.${String(RENDERER_FLOOR.minor)}（opentui 的门槛，ADR-056），现在是 v${process.versions.node}`,
    );
    context.stderr('  serve / run / sessions list / doctor 在 Node 22 上就能用');
    const command = sessionId === null ? 'tui' : `sessions resume ${sessionId}`;
    context.stderr(`  用 Node 26 运行：npx --yes node@26.12.0 "${CLI_ENTRY}" ${command}`);
    return EXIT.failed;
  }

  const host = await buildHost(context);
  if (host === null) return EXIT.failed;

  const { createClient, createServer, memoryTransport } = await import('@corescense/cowcat-protocol');
  const pair = memoryTransport();
  const server = createServer({ host, transport: pair.server });
  const client = createClient({ transport: pair.client });

  try {
    // Imported only once the floor is known to be met — this is the one import in the tree
    // that loads a renderer (and its native core).
    const { runTui: render } = await import('@corescense/cowcat-tui');
    return await render({ client, sessionId, version: readVersion() });
  } finally {
    try {
      client.close();
      await server.closed;
    } finally {
      // The session lock is the one thing that must not survive a bad exit (ADR-010). This
      // is a `finally` and not a plain sequence because a first attempt at the wiring let a
      // renderer's teardown error skip this line — and the next run then reported "writer
      // pid … is gone but left its lock file behind".
      await host.close();
    }
  }
}
