// /init: one LLM call (read-only exploration) to draft a COWCAT.md for the
// project. The draft is shown to the user and written only after confirmation.
import { Permissions } from './permissions.js';
import { runLoop } from './loop.js';

export const INIT_SYSTEM = `You are drafting a COWCAT.md project-instructions file. Explore the project with your read-only tools (Glob/Grep/Read, plus read-only Bash like ls or git status) until you understand its structure, then output the draft file and nothing else — no preamble, no code fences around the whole document.

The draft must be practical and short (aim for under 60 lines): what the project is, how to build/test/lint it, directory conventions, and any gotchas a coding agent must know. Use Markdown headings. Do not invent commands you did not verify exist.`;

export async function generateCowcatMd({ provider, registry, config, ui, cwd, maxTurns = 6 }) {
  const perms = new Permissions('plan'); // read-only exploration
  const ctx = { cwd, readSet: new Set(), state: {}, ui, permissions: perms, config };
  const messages = [{
    role: 'user',
    content: 'Explore the current project and draft its COWCAT.md. Verify build/test commands before including them.',
  }];
  const res = await runLoop({
    provider, registry, system: INIT_SYSTEM, messages, ctx, ui,
    permissions: perms, config, maxIterations: maxTurns,
    toolFilter: (name) => ['Read', 'Glob', 'Grep', 'Bash'].includes(name),
  });
  return res.finalText;
}
