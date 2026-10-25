import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT } from './exit.js';
import { flagValue } from './flags.js';
import { buildHost } from './host.js';
import type { CommandContext } from './spec.js';
import { readVersion } from './version.js';
import { defaultEntryProblem } from './runtime.js';

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
 * ## Working directory (ADR-146)
 *
 * The host is built against `process.cwd()`, so this verb decides the cwd BEFORE building:
 * a `--worktree` names a fresh checkout under the main repo (created, inherited into trust,
 * and cleaned up on exit per ADR-144/145); resuming any session restores the directory its
 * header recorded, warning — not failing — when that directory is gone.
 *
 * ## The Node floor check (ADR-065 ①)
 *
 * This package runs on Node 22; the renderer needs 26.4. The check therefore happens HERE,
 * before the dynamic import, so an old Node gets a sentence rather than a native-module
 * failure from three frames deep.
 */
/** The executable this verb came in through, for a copy-pasteable workaround. */
const CLI_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));

export async function runTui(context: CommandContext): Promise<number> {
  return startTui(context, flagValue(context.flags, 'session'));
}

/** Shared by the `tui` verb and `sessions resume <id>`. */
export async function startTui(context: CommandContext, sessionId: string | null): Promise<number> {
  const problem = defaultEntryProblem(process.versions.node);
  if (problem !== null) {
    context.stderr(`cowcat tui: ${problem}（opentui 的门槛，ADR-056）`);
    context.stderr('  serve / run / sessions list / doctor 在 Node 22 上就能用');
    const command = sessionId === null ? 'tui' : `sessions resume ${sessionId}`;
    context.stderr(`  用 Node 26 运行：npx --yes node@26.12.0 "${CLI_ENTRY}" ${command}`);
    return EXIT.failed;
  }

  // --worktree: the session lives in a sibling checkout. Creation/adoption happens BEFORE
  // the host is built — the worktree path becomes the cwd everything below resolves from.
  // mainCwd is kept for the exit cleanup: a process cannot delete its own cwd on Windows,
  // and cleanupWorktree needs the MAIN checkout as its git anchor anyway (review P1-3).
  const worktreeName = flagValue(context.flags, 'worktree');
  const mainCwd = process.cwd();
  let worktree: { readonly path: string; readonly branch: string; readonly created: boolean; readonly mainGitDir: string } | null = null;
  if (worktreeName !== null) {
    const ensured = await ensureWorktreeForSession(context, worktreeName);
    if (ensured === null) return EXIT.failed;
    worktree = ensured;
    process.chdir(worktree.path);
    context.stderr(`worktree 会话：${worktree.path}（分支 ${worktree.branch}）`);
  } else if (sessionId !== null) {
    // Resuming restores the workspace the session was opened in (ADR-146); a missing
    // directory downgrades to a warning, never a refusal — the session can still be read.
    await restoreSessionCwd(context, sessionId);
  }

  const hostOptions = worktree === null
    ? {}
    : { extraPaths: { write: [worktree.mainGitDir], read: [worktree.mainGitDir] } };
  const firstHost = await buildHost(context, hostOptions);
  if (firstHost === null) return EXIT.failed;

  const { createClient, createServer, memoryTransport } = await import('@corescense/cowcat-protocol');
  const servers: (ReturnType<typeof createServer>)[] = [];
  const clients: (ReturnType<typeof createClient>)[] = [];
  // Every connection gets a host of its own (ADR-157 ③): the trust gate grants and then
  // reconnects to pick up the project layer, and a shared host would keep the untrusted
  // startup snapshot forever. Session state is not lost — the logs on disk are the truth,
  // and the reconnected host replays them.
  const hosts: [typeof firstHost] = [firstHost];
  let connections = 0;
  const connect = async () => {
    connections += 1;
    // The FIRST connection uses the host built above; every later one rebuilds, so a
    // trust grant between them is picked up by the next snapshot.
    const host = connections === 1 ? firstHost : await buildHost(context, hostOptions);
    if (host === null) throw new Error('重建宿主失败（配置可能刚变得不可用）');
    if (host !== firstHost) hosts.push(host);
    const pair = memoryTransport();
    servers.push(createServer({ host, transport: pair.server }));
    const created = createClient({ transport: pair.client });
    clients.push(created);
    return created;
  };
  const client = await connect();

  try {
    // Imported only once the floor is known to be met — this is the one import in the tree
    // that loads a renderer (and its native core).
    const { runTui: render } = await import('@corescense/cowcat-tui');
    return await render({ client, sessionId, version: readVersion(), reconnect: () => connect() });
  } finally {
    try {
      for (const connected of clients) connected.close();
      await Promise.all(servers.map((server) => server.closed));
    } finally {
      // The session lock is the one thing that must not survive a bad exit (ADR-010). This
      // is a `finally` and not a plain sequence because a first attempt at the wiring let a
      // renderer's teardown error skip this line — and the next run then reported "writer
      // pid … is gone but left its lock file behind".
      for (const built of hosts) await built.close();
    }
    // Exit cleanup runs after the host is down (its processes are done). Only a worktree
    // created or adopted by THIS run is examined; the rules are ADR-144 ⑤. chdir back to
    // the main checkout first: cleanup needs it as the git anchor, and a process cannot
    // have its cwd deleted out from under it (Windows refuses the remove).
    if (worktree !== null) {
      process.chdir(mainCwd);
      await cleanupWorktreeForSession(context, worktree);
    }
  }
}

/** Build the worktree, or print the refusal. All of it goes through ProcessPort (ADR-014). */
async function ensureWorktreeForSession(
  context: CommandContext,
  name: string,
): Promise<{ readonly path: string; readonly branch: string; readonly created: boolean; readonly mainGitDir: string } | null> {
  const core = await import('@corescense/cowcat-core');
  const paths = (await import('./host.js')).stateDir();
  const cowcatPaths = core.cowcatPaths({ cwd: process.cwd(), home: (await import('node:os')).homedir(), ...(paths === null ? {} : { dir: paths }) });
  const fs = new core.NodeFs();
  const platform = new core.NodePlatform({ env: process.env });
  const processes = new core.NodeProcess({
    platform,
    sandboxCommand: core.createSandboxExecutor({ platform, fsProbe: core.fsProbeFrom(fs) }),
  });
  const result = await core.ensureWorktree(
    {
      process: processes,
      fs,
      trust: new core.FileTrustStore({ file: cowcatPaths.trustFile, fs }),
      mainCwd: process.cwd(),
    },
    name,
  );
  if (result.ok) return result.worktree;
  context.stderr(`cowcat --worktree: ${result.error}`);
  return null;
}

/** ADR-144 ⑤: clean (and fully pushed) trees disappear with their branch; work is kept. */
async function cleanupWorktreeForSession(
  context: CommandContext,
  worktree: { readonly path: string; readonly branch: string; readonly mainGitDir: string },
): Promise<void> {
  const core = await import('@corescense/cowcat-core');
  const fs = new core.NodeFs();
  const platform = new core.NodePlatform({ env: process.env });
  const processes = new core.NodeProcess({
    platform,
    sandboxCommand: core.createSandboxExecutor({ platform, fsProbe: core.fsProbeFrom(fs) }),
  });
  const outcome = await core.cleanupWorktree(
    {
      process: processes,
      fs,
      // The cleanup path never writes the trust record; the load half is unused too.
      trust: { load: () => Promise.resolve({ trusted: [], problem: null }), add: () => Promise.resolve() },
      mainCwd: process.cwd(),
    },
    { path: worktree.path, branch: worktree.branch, created: true, mainGitDir: worktree.mainGitDir },
  );
  if (outcome === 'removed') {
    context.stderr(`worktree 已清理：${worktree.path}（分支 ${worktree.branch} 已删除）`);
  } else if (outcome === 'kept-dirty') {
    context.stderr(`worktree 有未提交或未推送的改动，已保留：${worktree.path}（分支 ${worktree.branch}）`);
  } else {
    context.stderr(`worktree 状态无法核实，已保留：${worktree.path}（分支 ${worktree.branch}）`);
  }
}

/**
 * Resume restores the recorded workspace (ADR-146). The header's cwd is a fact about where
 * the session lived; when the directory is gone the session continues in the launch
 * directory with a warning — the log is append-only and the binding is never rewritten.
 */
async function restoreSessionCwd(context: CommandContext, sessionId: string): Promise<void> {
  const core = await import('@corescense/cowcat-core');
  const { statePaths } = await import('./host.js');
  const paths = await statePaths();
  const entries = await core.createSessionIndex(paths.sessionsDir).list();
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  const cwd = entry?.cwd ?? null;
  if (cwd === null) return;
  if (!existsSync(cwd)) {
    context.stderr(`会话的工作目录 ${cwd} 已不存在，在 ${process.cwd()} 继续（ADR-146）`);
    return;
  }
  if (cwd !== process.cwd()) process.chdir(cwd);
}
