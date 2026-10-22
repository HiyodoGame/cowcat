import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import {
  SKILL_COMPATIBILITY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILENAME,
  skillNameProblem,
} from '../policy/skills.js';
import type { FsPort, SkillDiscovery, SkillFile, SkillLayer, SkillOrigin, SkillPort } from '../ports/index.js';
import { projectRootOf } from './instructions.js';

/**
 * The fields we honour (ADR-115 ①).
 *
 * `allowed-tools` is deliberately absent: it is parsed (so `doctor` can report it) but it
 * does not grant anything in v1 (ADR-117 ④). Every key outside this set is recorded in
 * `ignoredFields` instead of being silently dropped — an author who wrote
 * `disable-model-invocation` in the wrong spelling deserves to learn that it did nothing.
 */
const HONORED_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'disable-model-invocation',
]);

/**
 * The shape the spec defines, plus the two Claude Code fields we act on.
 *
 * Strict about types on purpose: a `metadata` map of numbers is a file that will not load
 * in another client either, and accepting it here would make CowCat the only place it works.
 */
const frontmatterSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  // A map, but its values are not constrained: we never read them, and rejecting a nested
  // `requires` object would refuse real skills that Claude Code accepts (2026-10-22: the
  // 24 `lark-*` skills in the author's `~/.claude/skills` all carry one).
  metadata: z.record(z.string(), z.unknown()).optional(),
  'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
  'disable-model-invocation': z.union([z.boolean(), z.string()]).optional(),
});

/** Refuse to hold a pathological file in memory; a real `SKILL.md` is far below this. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024;

export interface FileSkillsOptions {
  /** Path identity (ADR-017), also used to dedupe symlinked skill directories. */
  readonly fs: FsPort;
  /** The user's home directory; personal skills live under it. */
  readonly home: string;
}

/**
 * Discovers `SKILL.md` files in the four documented locations (ADR-114 ②).
 *
 * Two rules are load-bearing:
 *
 *   * the project root comes from `projectRootOf`, the same walk instructions use, so a
 *     repository's rules and its skills never come from different directories;
 *   * a symlinked skill directory is deduped by canonical path across all four roots, so a
 *     personal symlink to a checked-in skill is one skill, not two.
 *
 * Nothing here decides precedence or trust: that is `policy/skills.ts`, which can be tested
 * without a filesystem (ADR-114 ③/④).
 */
export class FileSkills implements SkillPort {
  readonly #fs: FsPort;
  readonly #home: string;

  constructor(options: FileSkillsOptions) {
    this.#fs = options.fs;
    this.#home = options.home;
  }

  async discover(cwd: string): Promise<SkillDiscovery> {
    const projectRoot = projectRootOf(this.#fs, cwd);
    const roots: readonly Root[] = [
      { dir: join(this.#home, '.cowcat', 'skills'), layer: 'user', origin: 'cowcat' },
      { dir: join(this.#home, '.claude', 'skills'), layer: 'user', origin: 'claude' },
      // No project root, no project layer: outside a repository these two entries would
      // point at the filesystem root and scan directories that have nothing to do with
      // the session (ADR-114 ②).
      ...(projectRoot === null
        ? []
        : ([
            { dir: join(projectRoot, '.cowcat', 'skills'), layer: 'project', origin: 'cowcat' },
            { dir: join(projectRoot, '.claude', 'skills'), layer: 'project', origin: 'claude' },
          ] as const)),
    ];

    const skills: SkillFile[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const root of roots) {
      const entries = await listDirectories(root.dir);
      if (entries === null) continue;
      for (const entry of [...entries].sort()) {
        const directory = join(root.dir, entry);
        // A personal symlink to a checked-in skill is one skill, not two (ADR-114 ②).
        const canonical = this.#fs.canonical(directory);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const result = await readSkill(directory, entry, root);
        if (result.skill !== null) skills.push(result.skill);
        else if (result.warning !== null) warnings.push(result.warning);
      }
    }

    return { skills, warnings };
  }
}

interface Root {
  readonly dir: string;
  readonly layer: SkillLayer;
  readonly origin: SkillOrigin;
}

interface ReadResult {
  readonly skill: SkillFile | null;
  readonly warning: string | null;
}

async function readSkill(directory: string, directoryName: string, root: Root): Promise<ReadResult> {
  // The exact filename, checked against the directory listing rather than by opening it:
  // Windows is case-insensitive, so `readFile('SKILL.md')` would happily read a `skill.md`
  // and produce a skill that cannot be shared with the Linux/macOS machines we release on.
  const entries = await listNames(directory);
  if (entries === null || !entries.includes(SKILL_FILENAME)) return { skill: null, warning: null };
  const path = join(directory, SKILL_FILENAME);
  const text = await readText(path);
  // The listing named it but the read failed: permission, a lock, a vanishing symlink.
  // That is "present but unusable", which the port contract says must be reported — a
  // skill the user can see on disk but that silently never loads is the worst outcome.
  if (text === null) return { skill: null, warning: `${path}: SKILL.md exists but could not be read` };
  if (text.length > MAX_SKILL_FILE_BYTES) {
    return { skill: null, warning: `${path}: SKILL.md is larger than 1 MB` };
  }

  const front = splitFrontmatter(text);
  if ('problem' in front) return { skill: null, warning: `${path}: ${front.problem}` };

  let raw: unknown;
  try {
    raw = parse(front.yaml);
  } catch (error) {
    return { skill: null, warning: `${path}: frontmatter is not valid YAML (${message(error)})` };
  }
  const parsed = frontmatterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? 'frontmatter' : first.path.join('.') || 'frontmatter';
    return { skill: null, warning: `${path}: ${where}: ${first?.message ?? 'invalid'}` };
  }
  const data = parsed.data;

  const name = data.name ?? directoryName;
  const nameProblem = skillNameProblem(name, directoryName);
  if (nameProblem !== null) return { skill: null, warning: `${path}: ${nameProblem}` };

  const description = data.description ?? firstLine(front.body);
  if (description.trim() === '') return { skill: null, warning: `${path}: description is empty` };
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return {
      skill: null,
      warning: `${path}: description is longer than ${String(SKILL_DESCRIPTION_MAX)} characters`,
    };
  }
  if (data.compatibility !== undefined && data.compatibility.length > SKILL_COMPATIBILITY_MAX) {
    return {
      skill: null,
      warning: `${path}: compatibility is longer than ${String(SKILL_COMPATIBILITY_MAX)} characters`,
    };
  }

  const body = front.body.trim();
  if (body === '') return { skill: null, warning: `${path}: SKILL.md has no body` };

  const ignoredFields = Object.keys(asRecord(raw)).filter((key) => !HONORED_FIELDS.has(key));
  return {
    skill: {
      name,
      description: description.trim(),
      path,
      root: directory,
      layer: root.layer,
      origin: root.origin,
      body,
      ignoredFields,
      hidden: isTruthy(data['disable-model-invocation']),
    },
    warning: null,
  };
}

/**
 * YAML frontmatter, or why there is none.
 *
 * The opening `---` must be the file's first line, which is what every implementation we
 * looked at requires; anything else is treated as content and refused, because guessing
 * would turn a broken skill into one with no metadata and no way to trigger it (ADR-114 ⑤).
 */
function splitFrontmatter(text: string): { readonly yaml: string; readonly body: string } | { readonly problem: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return { problem: 'SKILL.md must start with a YAML frontmatter block' };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { problem: 'frontmatter is not closed with ---' };
  return { yaml: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

async function listNames(dir: string): Promise<readonly string[] | null> {
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}

async function listDirectories(dir: string): Promise<readonly string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function firstLine(body: string): string {
  const line = body.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.replace(/^#+\s*/, '').trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Claude Code accepts `yes`/`on`/`1` as well as `true`, in any case. */
function isTruthy(value: boolean | string | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
