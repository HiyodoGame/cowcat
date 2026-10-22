import { homedir } from 'node:os';
import type { CowcatHost, CowcatPaths } from '@corescense/cowcat-core';
import { flagValue } from './flags.js';
import type { CommandContext } from './spec.js';
import { readVersion } from './version.js';

/**
 * Assembling the real host for a verb (ADR-062 ③, ADR-064).
 *
 * This package is allowed to import the kernel, and it is the only one that is: the
 * boundary the rest of the tree keeps is "the frontend speaks a protocol", and the bin
 * is not the frontend — it is the thing that decides which of the two halves a verb
 * needs. Every import of `@corescense/cowcat-core` here is *dynamic*, so `--help`,
 * `--version` and an unknown verb never load the model SDKs.
 */

/** The process facts the host cannot read for itself (it may not touch the runtime). */
export function stateDir(): string | null {
  const value = process.env.COWCAT_HOME;
  return value === undefined || value === '' ? null : value;
}

export async function statePaths(): Promise<CowcatPaths> {
  const { cowcatPaths } = await import('@corescense/cowcat-core');
  const dir = stateDir();
  return cowcatPaths({
    cwd: process.cwd(),
    home: homedir(),
    ...(dir === null ? {} : { dir }),
  });
}

/**
 * The host, or `null` when the configuration cannot be used — in which case the reason
 * has already been printed and the caller returns `EXIT.failed`.
 *
 * A null rather than a thrown error because every wired verb needs the same three lines
 * of handling, and an exception would spread a `try` over each handler's body.
 */
export async function buildHost(
  context: CommandContext,
  options: { readonly unattended?: boolean } = {},
): Promise<CowcatHost | null> {
  const { createHost, HostConfigError } = await import('@corescense/cowcat-core');
  const configPath = flagValue(context.flags, 'config');
  try {
    return await createHost({
      cwd: process.cwd(),
      home: homedir(),
      env: process.env,
      version: readVersion(),
      paths: await statePaths(),
      ...(configPath === null ? {} : { configPath }),
      ...(options.unattended === true ? { unattended: true } : {}),
    });
  } catch (error) {
    if (error instanceof HostConfigError) {
      context.stderr('cowcat: 配置无法使用');
      for (const problem of error.problems) context.stderr(`  ${problem}`);
      context.stderr('（修好上面这几行再试；配置的三层与合并规则见 docs/architecture/README.md 的 ADR-025/026/064）');
      return null;
    }
    context.stderr(`cowcat: 宿主起不来：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
