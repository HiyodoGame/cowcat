// Memory system (persistence §5): multi-level, read-only, deduplicated.
//   user level:    ~/.cowcat/CLAUDE.md
//   project level: walking up from cwd (stopping at home / filesystem root):
//                  CLAUDE.md, .cowcat/CLAUDE.md, .cowcat/rules/*.md (sorted)
// Existing project-instruction files (COWCAT.md/AGENTS.md/CLAUDE.md from
// project.js) are passed in so the same file is never injected twice.
// COWCAT_DISABLE_MEMORY=1 skips everything. Files are never auto-created.
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cowcatHome } from './config.js';

export const MEMORY_FILE_LIMIT = 10_000;

const TEMPLATE = `# CLAUDE.md — project memory for CowCat

What this file is: durable instructions for any coding agent working in this
project. Loaded into the system prompt on every session start. Keep it short
and factual — long files get truncated and dilute the signal.

Good contents:
- what the project is and how to build/test/lint it (verified commands only)
- conventions a newcomer must not break (naming, layout, import order)
- gotchas: files that look editable but are generated, traps in the tooling

What does not belong here: task-specific plans, one-off notes, secrets.
`;

export function memoryDisabled(env = process.env) {
  const v = env.COWCAT_DISABLE_MEMORY;
  return v === '1' || v === 'true';
}

function readTrimmed(file) {
  try {
    const content = readFileSync(file, 'utf8').trim();
    if (!content) return null;
    return content.length > MEMORY_FILE_LIMIT ? `${content.slice(0, MEMORY_FILE_LIMIT)}\n[truncated]` : content;
  } catch { return null; }
}

// Collect memory entries. `alreadyInjected` is a Set of resolved paths that
// project-context injection handled; those files are skipped here.
export function collectMemories({ cwd, skipPaths = new Set(), env = process.env } = {}) {
  if (memoryDisabled(env)) return [];
  const entries = [];
  const seen = new Set(skipPaths);

  // user level
  const userFile = join(cowcatHome(), 'CLAUDE.md');
  const absUser = resolve(userFile);
  if (!seen.has(absUser)) {
    const content = readTrimmed(userFile);
    if (content) { entries.push({ level: 'user', path: absUser, content }); seen.add(absUser); }
  }

  // project levels: nearest directory first, stop at home or filesystem root
  const home = resolve(homedir());
  let dir = resolve(cwd);
  for (;;) {
    const candidates = [join(dir, 'CLAUDE.md'), join(dir, '.cowcat', 'CLAUDE.md')];
    for (const file of candidates) {
      const abs = resolve(file);
      if (seen.has(abs)) continue;
      const content = readTrimmed(file);
      if (content) { entries.push({ level: 'project', path: abs, content }); seen.add(abs); }
    }
    const rulesDir = join(dir, '.cowcat', 'rules');
    if (existsSync(rulesDir)) {
      let names = [];
      try { names = readdirSync(rulesDir).filter((n) => n.endsWith('.md')).sort(); } catch { /* unreadable */ }
      for (const name of names) {
        const abs = resolve(join(rulesDir, name));
        if (seen.has(abs)) continue;
        const content = readTrimmed(abs);
        if (content) { entries.push({ level: 'project-rule', path: abs, content }); seen.add(abs); }
      }
    }
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return entries;
}

export function memorySection(entry) {
  return `# Memory (${entry.level}: ${entry.path})\n\n${entry.content}`;
}

// Paths for the /memory command.
export function memoryPathFor(scope, cwd) {
  return scope === 'user' ? join(cowcatHome(), 'CLAUDE.md') : join(cwd, 'CLAUDE.md');
}

export function ensureMemoryFile(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, TEMPLATE);
    return true;
  }
  return false;
}

// /memory add <text>: append one line to the project-level memory file.
export function appendMemory(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n${text}\n`);
}
