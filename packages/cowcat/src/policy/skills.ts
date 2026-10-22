import type { SkillFile } from '../ports/skills.js';
import type { TrustState } from './trust.js';

/**
 * The filename every skill directory must carry (ADR-114 ②).
 *
 * Case-sensitive on purpose: the Agent Skills spec names it in upper case, and accepting
 * `skill.md` on Windows would create skills that cannot be shared with the Linux/macOS
 * machines this repository is released on.
 */
export const SKILL_FILENAME = 'SKILL.md';

/** The spec's ceilings (ADR-115 ②). */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMPATIBILITY_MAX = 500;

/**
 * The name grammar: lowercase alphanumerics, single hyphens, no leading/trailing hyphen.
 *
 * The spec requires exactly this, and a name outside it is not addressable by `/name` in
 * any client that follows the same rule — accepting one would create a skill nobody can
 * invoke by name.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Catalog ceiling when the preset declares no context window (ADR-116 ②). */
export const SKILL_CATALOG_BYTES = 8 * 1024;
/** Share of the window the catalog may take, when a window is known (ADR-116 ②). */
export const SKILL_CATALOG_SHARE = 0.02;
/**
 * A floor under the share. A small window would otherwise shrink the catalog to a few
 * hundred bytes, at which point it lists nothing and the feature silently disappears.
 */
export const SKILL_CATALOG_FLOOR = 1024;

/** How much of one skill body a single `Skill` call may return (ADR-117 ②). */
export const SKILL_BODY_MAX_BYTES = 32 * 1024;

export function skillCatalogBudget(window: number | undefined): number {
  if (window === undefined || window <= 0) return SKILL_CATALOG_BYTES;
  return Math.max(SKILL_CATALOG_FLOOR, Math.min(SKILL_CATALOG_BYTES, Math.floor(window * SKILL_CATALOG_SHARE)));
}

/**
 * Why a `name` is unusable, or null when it is fine (ADR-115 ②).
 *
 * The spec also requires `name` to equal the parent directory. That check lives here rather
 * than in the adapter because it is a rule, not a fact about the filesystem — the adapter
 * passes both values it already has.
 */
export function skillNameProblem(name: string, directory: string): string | null {
  if (name.length === 0) return 'name is empty';
  if (name.length > SKILL_NAME_MAX) return `name is longer than ${String(SKILL_NAME_MAX)} characters`;
  if (!SKILL_NAME_PATTERN.test(name)) return 'name must be lowercase letters, digits and single hyphens';
  if (name !== directory) return `name "${name}" does not match its directory "${directory}"`;
  return null;
}

/** Two skills with the same name, and which one survived (ADR-114 ④). */
export interface ShadowedSkill {
  readonly name: string;
  readonly winner: SkillFile;
  readonly loser: SkillFile;
}

/**
 * One skill per name.
 *
 * Rank is `layer × 10 + origin`: project over user, `.cowcat` over `.claude`. That is the
 * opposite of Claude Code's personal-over-project rule, and deliberately so: ADR-076 made
 * "more specific wins" the repository's answer for instructions, and a compatibility
 * directory is borrowed, not native (ADR-114 ④).
 *
 * The sort is stable, so two skills with the same rank keep discovery order and the first
 * one is the one that survives — a deterministic answer even for a case that should not
 * happen (the adapter walks each root once).
 */
export function resolveSkills(files: readonly SkillFile[]): {
  readonly skills: readonly SkillFile[];
  readonly shadowed: readonly ShadowedSkill[];
} {
  const ordered = files.map((skill, index) => ({ skill, index, rank: rankOf(skill) }));
  ordered.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const byName = new Map<string, SkillFile>();
  const bestRank = new Map<string, number>();
  const shadowed: ShadowedSkill[] = [];
  for (const { skill, rank } of ordered) {
    const winner = byName.get(skill.name);
    if (winner === undefined) {
      byName.set(skill.name, skill);
      bestRank.set(skill.name, rank);
    } else {
      // Ascending order means a strictly higher rank replaces; an equal rank keeps the
      // first one discovered, which is the only deterministic answer for a case the
      // adapter should never produce.
      if (rank > (bestRank.get(skill.name) ?? 0)) {
        byName.set(skill.name, skill);
        bestRank.set(skill.name, rank);
        shadowed.push({ name: skill.name, winner: skill, loser: winner });
      } else {
        shadowed.push({ name: skill.name, winner, loser: skill });
      }
    }
  }
  return { skills: [...byName.values()], shadowed };
}

function rankOf(skill: SkillFile): number {
  return (skill.layer === 'project' ? 20 : 10) + (skill.origin === 'cowcat' ? 2 : 1);
}

export interface SkillCatalog {
  /** The block to inject, wrapper included. Empty when nothing fitted. */
  readonly text: string;
  /** The skills whose names made it into `text`, with the bytes each line took. */
  readonly listed: readonly CatalogEntry[];
  /** How many names the budget could not take. Zero in the normal case. */
  readonly omitted: number;
}

export interface CatalogEntry {
  readonly skill: SkillFile;
  /** UTF-8 bytes this skill's line contributed — full line or name-only line. */
  readonly bytes: number;
}

/**
 * The catalog the model reads (ADR-116 ①).
 *
 * Sorted by name, not by directory order: walk order follows the filesystem, and a prefix
 * that changes when two files are renamed is a prefix that misses the prompt cache. The
 * budget is spent in two passes — full lines first, then names only — because a name is the
 * only way to call a skill, so it outranks its description (ADR-116 ②).
 */
export function renderSkillCatalog(skills: readonly SkillFile[], maxBytes: number = SKILL_CATALOG_BYTES): SkillCatalog {
  const open =
    '<system-reminder>\nThe following skills are available. When a task matches one, call the Skill tool with its exact name before doing the work yourself.\n\n';
  const close = '\n</system-reminder>';
  const ordered = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const wrap = (lines: readonly string[]): string => `${open}${lines.join('\n')}${close}`;
  const entries = (lines: readonly string[]): readonly CatalogEntry[] =>
    ordered.map((skill, index) => ({ skill, bytes: utf8(lines[index] ?? '') }));

  const full = ordered.map((skill) => `- ${skill.name}: ${escapeFrame(clip(skill.description, SKILL_DESCRIPTION_MAX))}`);
  if (ordered.length === 0) return { text: '', listed: [], omitted: 0 };
  const fullText = wrap(full);
  if (utf8(fullText) <= maxBytes) return { text: fullText, listed: entries(full), omitted: 0 };

  // Names first, descriptions gone: the model can still call every one of them.
  const names = ordered.map((skill) => `- ${skill.name}`);
  const namesText = wrap(names);
  if (utf8(namesText) <= maxBytes) return { text: namesText, listed: entries(names), omitted: 0 };

  // Last resort: the names themselves do not fit. Keep the ones that do and say how many
  // were left out — silently dropping a name would make the catalog look complete.
  const kept: string[] = [];
  const listed: CatalogEntry[] = [];
  for (const [index, line] of names.entries()) {
    const skill = ordered[index];
    if (skill === undefined) break;
    const notice = `- …and ${String(ordered.length - listed.length - 1)} more (see /skills)`;
    const candidate = wrap([...kept, line]);
    // Leave room for the notice that follows a partial list.
    if (utf8(candidate) > maxBytes - utf8(notice)) break;
    kept.push(line);
    listed.push({ skill, bytes: utf8(line) });
  }
  const omitted = ordered.length - listed.length;
  const lines = omitted === 0 ? kept : [...kept, `- …and ${String(omitted)} more (see /skills)`];
  return { text: wrap(lines), listed, omitted };
}

/**
 * What to do with what was found (ADR-114 ③).
 *
 * `skipped-untrusted` is its own outcome, not folded into `none`, for the reason ADR-030
 * gave for instructions: "there is nothing" is silent, while "there is something and it was
 * not used" has to be said out loud.
 */
export type SkillsDecision =
  | {
      readonly kind: 'injected';
      readonly catalog: SkillCatalog;
      /** What the tool may load: trusted, visible, one per name. */
      readonly skills: readonly SkillFile[];
      readonly shadowed: readonly ShadowedSkill[];
      /** Project skills withheld because the folder is not trusted; reported, not silent. */
      readonly skipped: readonly SkillFile[];
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'skipped-untrusted'; readonly skills: readonly SkillFile[] };

export function decideSkills(
  files: readonly SkillFile[],
  trust: TrustState,
  maxBytes: number = SKILL_CATALOG_BYTES,
): SkillsDecision {
  // `disable-model-invocation` is honoured here rather than in the adapter: the rule is
  // "the model may not see it", which is a decision about the catalog, not about parsing.
  const visible = files.filter((skill) => !skill.hidden);
  if (visible.length === 0) return { kind: 'none' };

  const trusted = trust.trusted ? visible : visible.filter((skill) => skill.layer === 'user');
  const skipped = trust.trusted ? [] : visible.filter((skill) => skill.layer === 'project');
  if (trusted.length === 0) return { kind: 'skipped-untrusted', skills: skipped };

  const resolved = resolveSkills(trusted);
  const catalog = renderSkillCatalog(resolved.skills, maxBytes);
  if (catalog.text === '') return { kind: 'none' };
  return { kind: 'injected', catalog, skills: resolved.skills, shadowed: resolved.shadowed, skipped };
}

/**
 * The line a user needs when project skills were withheld.
 *
 * Names, not just a count: "skipped 3 skills" leaves the user unable to tell whether their
 * own skill was among them. Capped so a repository with a hundred skills does not turn one
 * notice into a wall.
 */
export function describeSkillSkip(skills: readonly SkillFile[]): string | null {
  if (skills.length === 0) return null;
  const names = skills.slice(0, 5).map((skill) => skill.name).join(', ');
  const more = skills.length > 5 ? ` (+${String(skills.length - 5)} more)` : '';
  return `folder not trusted: skipped ${String(skills.length)} skill${skills.length === 1 ? '' : 's'} (${names}${more}). Trust the folder to load them.`;
}

/** Repository-provided text must not close the frame we own (ADR-116 ③). */
function escapeFrame(text: string): string {
  return text.split('</system-reminder>').join('<\\/system-reminder>');
}

/** Longest prefix that fits `limit` characters, never splitting a surrogate pair. */
function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  let end = limit;
  const code = trimmed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${trimmed.slice(0, end)}…`;
}

/** Bytes, not code units: the budget is a prompt budget, and CJK costs three of them. */
function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}
