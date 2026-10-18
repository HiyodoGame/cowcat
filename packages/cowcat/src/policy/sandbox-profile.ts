// Turning resolved config into the profile a run executes under (P5 T5).
//
// Pure, and separate from the config merge on purpose: merging answers "what did the
// user ask for", this answers "what does that mean as paths and a policy" — and the
// second question needs `FsPort` (ADR-017) and a home directory, neither of which a
// config file knows anything about.
//
// The composition root calls this once and hands the result to the Bash tool. The tool
// itself never sees config: it receives a profile, which is what keeps "which sandbox"
// a decision made in one place.

import type { FsPort, SandboxProfile } from '../ports/index.js';
import type { ResolvedSandboxSettings } from './config.js';
import { resolveEntries } from './sandbox-paths.js';

export interface SandboxProfileContext {
  /** The session's working directory. Relative write entries resolve against it. */
  readonly cwd: string;
  /** Used for `~`. Injected rather than read from `node:os`, so this stays testable. */
  readonly home: string;
  readonly fs: FsPort;
}

export interface ResolvedSandboxProfile {
  readonly profile: SandboxProfile;
  /**
   * Entries the backends cannot honour (a glob, another user's home). Surfaced all the
   * way to `SandboxProfile.limitations` — a deny that looks configured and does nothing
   * is worse than no deny at all (research/p2-ports.md §3.1 item 9).
   */
  readonly unsupported: readonly { readonly entry: string; readonly why: string }[];
}

export function resolveSandboxProfile(
  settings: ResolvedSandboxSettings,
  context: SandboxProfileContext,
): ResolvedSandboxProfile {
  const resolve = (entries: readonly string[]) =>
    resolveEntries({ entries, cwd: context.cwd, home: context.home, fs: context.fs });

  const readAllow = resolve(settings.read.allow);
  const readDeny = resolve(settings.read.deny);
  const writeAllow = resolve(settings.write.allow);
  const writeDeny = resolve(settings.write.deny);

  const unsupported = [
    ...readAllow.unsupported.map((entry) => ({ ...entry, why: `read.allow: ${entry.why}` })),
    ...readDeny.unsupported.map((entry) => ({ ...entry, why: `read.deny: ${entry.why}` })),
    ...writeAllow.unsupported.map((entry) => ({ ...entry, why: `write.allow: ${entry.why}` })),
    ...writeDeny.unsupported.map((entry) => ({ ...entry, why: `write.deny: ${entry.why}` })),
  ];

  return {
    profile: {
      mode: settings.mode,
      backend: settings.backend,
      network: settings.network,
      env: { deny: settings.env.deny },
      read: { profile: settings.read.profile, allow: readAllow.resolved, deny: readDeny.resolved },
      write: { allow: writeAllow.resolved, deny: writeDeny.resolved },
      // Carried in the profile so the audit and the user read the same statement the
      // backends produced, not a paraphrase of it.
      limitations: unsupported.map((entry) => `${entry.entry} was not applied: ${entry.why}`),
    },
    unsupported,
  };
}
