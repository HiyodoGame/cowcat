// Project context: walk up from cwd looking for COWCAT.md -> AGENTS.md ->
// CLAUDE.md (first hit wins). Content is injected as a project-instructions
// section of the system prompt; read once at startup.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CANDIDATES = ['COWCAT.md', 'AGENTS.md', 'CLAUDE.md'];

export function findProjectContext(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CANDIDATES) {
      const file = join(dir, name);
      if (existsSync(file)) {
        let content;
        try { content = readFileSync(file, 'utf8').trim(); } catch { content = ''; }
        if (content) return { path: file, name, content };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Section appended to the main system prompt block.
export const PROJECT_SECTION = (ctx) =>
  `# Project instructions (${ctx.name} at ${ctx.path})

The following project-level instructions come from a file in the repository. They describe how the user wants work done in this project and take precedence over your general habits. Follow them for the rest of this session.

${ctx.content}`;
