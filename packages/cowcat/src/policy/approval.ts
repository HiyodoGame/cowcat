import type { ActionRequest } from './decide.js';

/** What a user (or a timeout) can answer an approval request with. */
export type ApprovalVerdict = 'once' | 'always' | 'reject';

/**
 * Who answered.
 *
 * `'policy'` is not a person and not a timeout: it is a standing `always` from
 * earlier in the same session letting a later identical call through. Recording it
 * explicitly is what keeps the log honest — otherwise an `ask` in the log would be
 * followed by a tool that ran with no answer in between, which reads like the kernel
 * ignored its own decision.
 *
 * `'unattended'` is the third non-person: nobody can be asked here at all (a delegated
 * child session, ADR-081 ③). It is not a timeout — waiting five minutes to learn that
 * no reader exists would be theatre — and it is not `'policy'`, which means an earlier
 * human answer still stands. Keeping them apart is what lets a log answer "did a person
 * decide this?" without guessing.
 */
export type ApprovalBy = 'user' | 'policy' | 'timeout' | 'unattended';

/**
 * The identity of "this same action" for an `always` answer.
 *
 * Precise on purpose. Keying on the tool name alone would mean that approving one
 * `Bash` command grants every `Bash` command for the rest of the session, which the
 * legacy implementation was careful not to do — it keyed Bash on the whole command
 * and the file tools on the path. v2 has no per-tool switch to make that choice in;
 * it uses the fields every request already declares (`command`, then `path`), and
 * falls back to the whole input only for tools that declare neither.
 *
 * The input fallback uses `JSON.stringify`, so two calls that differ only in key
 * order are two keys. That is conservative — a re-ordered call asks again rather
 * than being silently granted — and it is what the legacy code did too.
 */
export function approvalKey(request: ActionRequest): string {
  const subject = request.command ?? request.path ?? JSON.stringify(request.input ?? null);
  // A NUL separator cannot occur in a tool name from a model, so the two halves
  // cannot be made to collide by naming a tool `a<something>b`.
  return `${request.name}\u0000${subject}`;
}
