// PlatformPort — what the host is, and therefore what a run may rely on.
//
// The kernel, the policy layer and the tool layer never branch on process.platform
// (01-layers.md, ADR-003). Everything platform-shaped is answered here and nowhere
// else: which shell commands run through, how a process tree is terminated, and
// which sandbox backends actually work on this machine.
//
// Two things this port deliberately does NOT do:
//
//   * It does not probe by assuming. `bwrap` being installed is not the same as
//     bwrap being able to create a user namespace, and `sandbox-exec` existing is
//     not the same as a profile applying. The legacy probe runs the real thing for
//     exactly this reason (agent/src/sandbox/probe.js), and its classification is
//     the product contract: "bwrap is not installed", "user namespaces are blocked
//     by AppArmor" and "the kernel is too old" need three different fixes, so a
//     verdict carries `reason`, the underlying error's first line, and a
//     copy-pasteable `fix`.
//   * It does not answer "what should I do". It reports facts; the decision of
//     refusing vs degrading belongs to the sandbox executor's contract (ADR-016).

/**
 * `wsl` is separate from `linux` because bubblewrap runs inside the distro while
 * the fix instructions are distro-side, not Windows-side — reporting them as the
 * same platform would give the user the wrong command.
 */
export type PlatformId = 'linux' | 'macos' | 'windows' | 'wsl' | 'other';

export type ShellKind = 'posix' | 'git-bash' | 'powershell' | 'cmd';

/**
 * The two facts that make a session's log reproducible: which interpreter ran its
 * commands, and which binary was actually invoked. This — not the whole `Shell` — is
 * what the session header records, because `baseArgs`/`commandFlag` are derived from
 * `kind` and recording them too would be a second place to keep in sync.
 *
 * It lives here rather than in the kernel so `Shell` can extend it; a session's
 * reproducibility depends on knowing which shell interpreted its commands (ADR-012).
 */
export interface SessionShell {
  readonly kind: ShellKind;
  /** Absolute path. Never a bare name: on the reference machine `bash` on PATH is the
   * WSL launcher and, after it, an OpenSSH shim that runs but is the wrong shell. */
  readonly executable: string;
}

/**
 * The shell a command line is handed to. On Windows the order is Git Bash, then
 * PowerShell, then cmd.exe: Git Bash because its command semantics match the
 * POSIX toolchain this project assumes, PowerShell because it is always present
 * on supported Windows versions (docs/architecture/05-platforms.md). The legacy
 * agent had NO detection at all — it let Node pick `ComSpec`, and the "shell" in
 * its system prompt was a hardcoded string (agent/src/prompts/system.js).
 */
export interface Shell extends SessionShell {
  /** Flags that make it non-interactive, before the command. */
  readonly baseArgs: readonly string[];
  /** How the command itself is passed: `-c <cmd>` for POSIX-likes, `-Command <cmd>` for PowerShell. */
  readonly commandFlag: string;
}

/**
 * One backend's verdict. `usable: false` always carries `reason`; `fix` is present
 * whenever there is a command the user can actually run.
 */
export interface SandboxBackendVerdict {
  readonly name: 'bwrap' | 'seatbelt' | 'none';
  readonly usable: boolean;
  /** 'missing' | 'userns-blocked' | 'error' | 'unsupported-platform' | 'ok' | 'not-implemented' */
  readonly reason: string;
  readonly detail: string;
  readonly fix: string | null;
}

/** How this platform terminates a whole process tree (ADR-014). */
export interface TerminationStrategy {
  /** 'process-group' on POSIX (spawn detached, then signal the group); 'taskkill-tree' on Windows. */
  readonly kind: 'process-group' | 'taskkill-tree';
  /** Grace period before SIGKILL. Ignored on Windows, where SIGTERM is not catchable. */
  readonly graceMs: number;
  /**
   * Whether a graceful phase is even possible here. False on Windows: measured,
   * SIGTERM is not catchable, so `/F` is the only semantics available.
   */
  readonly supportsGraceful: boolean;
}

export interface PlatformPort {
  readonly platform: PlatformId;

  /**
   * The shell to run commands through, resolved once per session and recorded in
   * the session header (ADR-012): a session's reproducibility depends on knowing
   * which shell interpreted its commands.
   */
  resolveShell(): Shell;

  termination(): TerminationStrategy;

  /**
   * What the sandbox backends do here, right now. Probed rather than assumed;
   * a broken probe degrades to "no backend", never to a throw.
   */
  sandboxBackends(): readonly SandboxBackendVerdict[];
}

/** Thrown when a run asks for a sandbox mode this platform cannot honour (ADR-016). */
export class SandboxUnavailableError extends Error {
  readonly mode: 'system';
  readonly backend: string | null;
  readonly reason: string;
  /** Verbatim from the verdict, so the user gets the real reason instead of a paraphrase. */
  readonly detail: string;
  /** What to change instead — WSL2 or the light tier. Never "the sandbox is on". */
  readonly alternatives: readonly string[];

  constructor(backend: string | null, reason: string, detail: string, alternatives: readonly string[]) {
    super(`sandbox "system" is not available here [${reason}]: ${detail}`);
    this.name = 'SandboxUnavailableError';
    // Always "system": refusing the OS-level tier is the only case this exists for.
    // The field is there so a caller can branch without parsing the message.
    this.mode = 'system';
    this.backend = backend;
    this.reason = reason;
    this.detail = detail;
    this.alternatives = alternatives;
  }
}