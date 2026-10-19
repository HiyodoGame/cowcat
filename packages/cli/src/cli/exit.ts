/**
 * The three exit codes, in their own module (ADR-060).
 *
 * They were declared next to the dispatcher until the verb handlers had to return one
 * too, which would have made `spec → handler → run → spec` a cycle. The contract is
 * what matters and it has not changed: `0` did what was asked, `2` you typed it wrong,
 * `1` this build cannot do it or the execution failed.
 */
export const EXIT = {
  ok: 0,
  /** Well-formed invocation, capability missing or execution failed. */
  failed: 1,
  /** The command line itself was wrong (unknown verb, unknown option, missing argument). */
  usage: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
