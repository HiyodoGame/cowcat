import type { InstructionFile } from '../ports/instructions.js';
import type { TrustState } from './trust.js';

/**
 * The candidate filenames, in the order they are tried (ADR-029).
 *
 * `AGENTS.md` is the open standard; `CLAUDE.md` is a compatibility fallback, the
 * same arrangement opencode uses. There is deliberately no proprietary name here —
 * the legacy list put `COWCAT.md` first, which meant a repository that wrote the
 * standard file never had it read.
 */
export const INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * What to do with the instruction file that was found (ADR-030).
 *
 * Untrusted is its own outcome rather than being folded into `none`, because the
 * two need different handling: "there is no file" is silent, while "there is one and
 * it was not used" has to be said out loud. A file that silently stops applying is
 * the kind of quiet that costs an afternoon — the same reasoning behind ADR-025's
 * two-tier config errors.
 */
export type InstructionDecision =
  | { readonly kind: 'injected'; readonly file: InstructionFile }
  | { readonly kind: 'none' }
  | { readonly kind: 'skipped-untrusted'; readonly file: InstructionFile };

export function decideInstruction(file: InstructionFile | null, trust: TrustState): InstructionDecision {
  if (file === null) return { kind: 'none' };
  if (!trust.trusted) return { kind: 'skipped-untrusted', file };
  return { kind: 'injected', file };
}

/**
 * The notice to show when a file was found but not injected, or null when there is
 * nothing to say.
 *
 * The line count is included because it is the only thing that tells the user how
 * much was withheld — "we skipped your AGENTS.md" is not actionable without it.
 * Reloading after the directory is trusted is then just `decideInstruction` again
 * with the new trust: the decision is a pure function of the file and the trust, so
 * there is no cached state to invalidate.
 */
export function describeInstructionSkip(decision: InstructionDecision): string | null {
  if (decision.kind !== 'skipped-untrusted') return null;
  const lines = decision.file.content.split('\n').length;
  return `folder not trusted: skipped ${decision.file.name} (${String(lines)} lines). Trust the folder to load it.`;
}
