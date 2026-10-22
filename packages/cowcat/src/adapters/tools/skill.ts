import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SKILL_BODY_MAX_BYTES } from '../../policy/skills.js';
import type { SkillFile, ToolPort } from '../../ports/index.js';
import { defineTool } from './define-tool.js';

const DESCRIPTION = [
  'Load a skill: a local procedure or reference document the user installed for this workspace.',
  'Call it with the exact `name` from the skills list you were given. The full instructions come back as the tool result and stay in the conversation, so you do not need to call it again for the same task.',
  '',
  'When to use: the task matches a skill description, or the user names a skill. Read the returned instructions and follow them; when it points at bundled files (references, scripts, assets), read or run them with the normal tools — loading a skill does not pre-approve anything.',
  'When NOT to use: guessing. If the name is not in the list, the call returns the available names instead of an approximate match.',
].join('\n');

export interface SkillToolOptions {
  /** Trusted, visible skills, one per name (ADR-114 ③/④). */
  readonly skills: readonly SkillFile[];
  /** How much of one body this call may return (ADR-117 ②). */
  readonly maxBytes?: number;
}

/**
 * `Skill` — the second half of progressive disclosure (ADR-116/117).
 *
 * Read-only and pathless: the model names a skill that discovery already found, and this
 * tool reads the file recorded at discovery time. There is no path argument, so `../` is
 * not a thing an input can express, and no rule has to be written to stop it.
 *
 * The body is capped rather than refused: a skill over the cap is unusual (the spec
 * recommends about 5k tokens), and returning its head with an explicit truncation fact is
 * more useful than a failure that leaves the model with nothing.
 */
export function createSkillTool(options: SkillToolOptions): ToolPort {
  const maxBytes = options.maxBytes ?? SKILL_BODY_MAX_BYTES;
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));

  return defineTool(
    {
      name: 'Skill',
      description: DESCRIPTION,
      risk: 'read',
      input: z.object({
        name: z.string().min(1).describe('Exact skill name from the available skills list'),
      }),
    },
    async (input) => {
      const skill = byName.get(input.name);
      if (skill === undefined) {
        const names = [...byName.keys()].sort();
        const shown = names.slice(0, 40);
        const more = names.length > shown.length ? ` (+${String(names.length - shown.length)} more)` : '';
        return {
          ok: false,
          output:
            names.length === 0
              ? 'No skills are available in this workspace.'
              : `No skill named "${input.name}". Available: ${shown.join(', ')}${more}`,
          truncation: { truncated: false, dropped: 0, reason: null },
        };
      }

      const bundled = await listBundled(skill.root);
      const header = `# Skill: ${skill.name}\n\n${skill.description}\n`;
      const tail =
        bundled.length === 0
          ? `\n\nNo bundled files. Skill root: ${skill.root}`
          : `\n\nBundled files (relative to ${skill.root}):\n${bundled.map((entry) => `- ${entry}`).join('\n')}`;
      const full = `${header}\n${skill.body}${tail}`;
      const limit = maxBytes;
      const bytes = utf8(full);
      if (bytes <= limit) {
        return { ok: true, output: full, truncation: { truncated: false, dropped: 0, reason: null } };
      }

      const marker = `\n\n[… skill body truncated to ${String(limit)} bytes; ${String(bytes - limit)} bytes omitted. Read ${skill.path} directly if you need the rest.]`;
      const room = Math.max(0, limit - utf8(marker));
      const kept = clipUtf8(full, room);
      return {
        ok: true,
        output: `${kept}${marker}`,
        truncation: { truncated: true, dropped: bytes - utf8(kept), reason: `skill body: ${String(limit)} bytes` },
      };
    },
  );
}

/**
 * One level of the conventional directories, plus stray files.
 *
 * One level is enough: the spec tells skill authors to keep references one hop from
 * `SKILL.md`, and a full tree walk would spend the call's budget listing a directory the
 * model may never need.
 */
async function listBundled(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const directory of ['references', 'scripts', 'assets']) {
    out.push(...(await listOne(join(root, directory), `${directory}/`)));
  }
  // Loose files beside SKILL.md, excluding the file itself and the three directories
  // already listed — otherwise the list repeats what the caller just read.
  try {
    const entries = await readdir(root, { withFileTypes: true });
    out.push(
      ...entries
        .filter((entry) => entry.isFile() && entry.name !== 'SKILL.md' && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort(),
    );
  } catch {
    // A missing root only means there is nothing to list.
  }
  return out.slice(0, 200);
}

async function listOne(directory: string, prefix: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort();
  } catch {
    return [];
  }
}

/** Bytes, not code units; CJK costs three of them and the cap is a prompt budget. */
function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Longest prefix that fits `limit` bytes, never splitting a code point. */
function clipUtf8(text: string, limit: number): string {
  if (limit <= 0) return '';
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8(char);
    if (used + size > limit) break;
    used += size;
    end += char.length;
  }
  return text.slice(0, end);
}
