import type { ActionRequest } from './decide.js';

/** What a user (or a timeout) can answer an approval request with. */
export type ApprovalVerdict = 'once' | 'always' | 'session' | 'reject';

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
 * Normalizes a subject before it keys a grant or a refusal (ADR-129, review P2-3):
 * trimmed, interior whitespace runs collapsed to one space. Without it `npm test` and
 * `npm  test` are two different keys, and a refused subject re-asks the moment a model
 * varies its spacing.
 */
export function normalizeSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, ' ');
}

/**
 * The identity of "this same action" for an `always` answer.
 *
 * Precise on purpose. Keying on the tool name alone would mean that approving one
 * `Bash` command grants every `Bash` command for the rest of the session, which the
 * legacy implementation was careful not to do — it keyed Bash on the whole command
 * and the file tools on the path. v2 keeps that for `always`; the coarse "this whole
 * tool, this session" grant exists as its own answer (`session`, ADR-094) so the two
 * questions are not conflated. `always` uses the fields every request already declares
 * (`command`, then `path`), and falls back to the whole input only for tools that
 * declare neither.
 *
 * The input fallback uses `JSON.stringify`, so two calls that differ only in key
 * order are two keys. That is conservative — a re-ordered call asks again rather
 * than being silently granted — and it is what the legacy code did too.
 *
 * Command subjects are normalized (see normalizeSubject), so a grant, a refusal, and
 * the request that follows them all hash to the same key.
 */
export function approvalKey(request: ActionRequest): string {
  const subject = request.command !== undefined ? normalizeSubject(request.command) : (request.path ?? JSON.stringify(request.input ?? null));
  // A NUL separator cannot occur in a tool name from a model, so the two halves
  // cannot be made to collide by naming a tool `a<something>b`.
  return `${request.name}\u0000${subject}`;
}

/**
 * The key an `session` answer grants: the whole tool, for this session only.
 *
 * `always` is deliberately exact (ADR-031 decision 3): it grants the command that was
 * shown, not the tool. That precision is right for the question "is this action okay?"
 * and wrong for the question users actually answer with "always" — thirty-six Bash
 * calls in one measured session, thirty-six different commands, eleven `always` answers
 * and zero reuses. So the coarse grant exists, but as its own answer (`session`) with
 * its own label, rather than by quietly redefining `always` and widening an existing
 * grant people had already given.
 *
 * The subject is `"*"` — JSON-quoted, where the old bare `*` lived — because a bare
 * `*` IS a real command (`bash -c '*'` is legal input), and the old bare form made
 * approvalKey for that command identical to this grant: one odd approval became a
 * whole-tool bypass (review of the ADR-129 security review, P1-4). The quoted form
 * cannot be produced by a command or path subject, and NUL stays the separator.
 */
export function toolGrantKey(name: string): string {
  return `${name}\u0000"*"`;
}

/**
 * The pre-ADR-129 tool-grant spelling (`name NUL *`). Session answers recorded before
 * the fix replay into grants under this key, so the standing check must still honor
 * it; nothing new is ever emitted with it.
 */
export function legacyToolGrantKey(name: string): string {
  return `${name}\u0000*`;
}
