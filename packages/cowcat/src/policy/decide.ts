import type { ToolRisk } from '../ports/index.js';

export type Verdict = 'allow' | 'ask' | 'deny';

/**
 * What a rule adjudicates. Carries the tool's own facts plus the two things a
 * rule may narrow on: the path this action touches and the command it runs.
 *
 * `path` must already be canonical (ADR-017: FsPort owns path identity) — the
 * caller resolves it, the policy layer only compares. `command` is the raw
 * command text; rules match it by prefix only (ADR-027), which is why a rule can
 * never see how a command was spelled differently.
 */
export interface ActionRequest {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly risk: ToolRisk;
  /** Raw tool input. Rules do not read it; kept so a caller can pass it on. */
  readonly input?: unknown;
  /** Canonical absolute path, resolved by the caller through FsPort. */
  readonly path?: string;
  /** Command text for exec actions. Matched by prefix only. */
  readonly command?: string;
}

/**
 * The match surface of a rule (ADR-027). Every field is optional and omitting one
 * means "do not care". Present fields are ANDed.
 *
 * This is data, not a function, on purpose: the P3 exit criterion is that every
 * verdict can be expressed in configuration without changing code, and a function
 * cannot be written in a config file.
 *
 * `path` is an **absolute, canonical, literal** path — the same contract
 * `PathPolicyResolver.resolve` already uses (ports/fs.ts:55): a glob is rejected,
 * not ignored. `resolveEntries`-style unsupported patterns are reported by
 * `validateRules` and skipped by the loader, never silently applied.
 */
export interface RuleWhen {
  /** Tool name, or any of several. A bare `'*'` matches every tool. */
  readonly tool?: string | readonly string[];
  readonly risk?: ToolRisk | readonly ToolRisk[];
  /** Absolute canonical path, or a directory prefix of one. */
  readonly path?: string;
  /** Command prefix. `'npm run test'` matches `'npm run test --watch'`. */
  readonly command?: string;
}

export interface Rule {
  readonly name: string;
  readonly verdict: Verdict;
  readonly reason?: string;
  /** Required, so a rule cannot accidentally match everything by omission. */
  readonly when: RuleWhen;
}

export interface Decision {
  readonly verdict: Verdict;
  readonly rule: string;
  readonly reason: string | null;
}

const PRECEDENCE: readonly Verdict[] = ['deny', 'ask', 'allow'];

const RISKS: readonly ToolRisk[] = ['read', 'write', 'exec', 'network'];

// Glob metacharacters. The legacy `Edit(src/**)` grammar is deliberately NOT
// carried over: `policy/` stays runtime-agnostic and cannot ask `FsPort` about
// the filesystem, and re-implementing glob here would create a second path
// matcher that can disagree with the one ADR-017 made authoritative. A pattern we
// cannot honour is reported (validateRules) and must be skipped by the loader —
// the same treatment PathPolicyResolver gives an unsupported entry.
const GLOB_CHARS = /[*?[\]{}]/;

function asArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : ([value] as readonly T[]);
}

/** Both separators, because a canonical path on Windows starts with a drive letter. */
function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function hasTrailingSeparator(path: string): boolean {
  return /[\\/]$/.test(path);
}

/**
 * Literal-or-prefix comparison on canonical paths. Separator-agnostic so the same
 * rule text works on Windows and POSIX; the caller is responsible for the paths
 * being canonical, which is what makes plain string comparison correct here.
 *
 * A pattern that is not absolute never matches: a relative path would depend on a
 * working directory the policy layer does not have.
 */
function matchesPath(pattern: string, path: string): boolean {
  if (!/^([\\/]|[A-Za-z]:[\\/])/.test(pattern)) return false;
  const p = trimTrailingSeparators(path.replace(/\//g, '\\'));
  const q = trimTrailingSeparators(pattern.replace(/\//g, '\\'));
  // The filesystem root trims to "" and would then prefix-match every absolute
  // path (on POSIX the trim leaves a single separator, which every path starts
  // with). validateRules reports it; this makes decide refuse it too, so a rule
  // that somehow reaches decide still cannot match everything by accident.
  if (q === '' || q === '\\') return false;
  if (p === q) return true;
  // A trailing separator on the pattern means "this directory's contents" and
  // nothing else; without one it is still a prefix, because a directory rule is
  // the only useful reading of "this tree".
  return p.startsWith(q + '\\');
}

function matchesCommand(pattern: string, command: string): boolean {
  const c = command.trim();
  if (c === pattern) return true;
  if (!c.startsWith(pattern)) return false;
  // Boundary, so `npm run test` does not match `npm run testing`. The legacy rule
  // used the same boundary set (agent/src/perrules.js:77).
  return [' ', ':', '/', '\\'].includes(c[pattern.length] ?? '');
}

function matchesWhen(when: RuleWhen, request: ActionRequest): boolean {
  if (when.tool !== undefined) {
    const tools = asArray(when.tool);
    if (!tools.some((t) => t === '*' || t === request.name)) return false;
  }
  if (when.risk !== undefined) {
    if (!asArray(when.risk).includes(request.risk)) return false;
  }
  if (when.path !== undefined) {
    // Fail closed: a rule that narrows on a path does not match an action with no
    // path, and never matches an unsupported (glob) pattern.
    if (request.path === undefined || GLOB_CHARS.test(when.path)) return false;
    if (!matchesPath(when.path, request.path)) return false;
  }
  if (when.command !== undefined) {
    if (request.command === undefined) return false;
    if (!matchesCommand(when.command, request.command)) return false;
  }
  return true;
}

export interface RuleProblem {
  /** Index into the rules array the problem came from. */
  readonly index: number;
  readonly rule: string;
  readonly problem: string;
}

/**
 * Reports rules `decide` cannot honour correctly. This exists because `decide` is
 * total: it must never throw in the tool path, so an unusable rule has to be
 * caught before it is loaded rather than blowing up mid-turn.
 *
 * The loader's contract (ADR-025 decision 5) is two-tiered: a problem here means
 * **skip this rule and warn**, keep the rest. Skipping is why an unsupported deny
 * rule must never be silently ignored without a warning — see the note on
 * `GLOB_CHARS`.
 */
export function validateRules(rules: readonly Rule[]): readonly RuleProblem[] {
  const problems: RuleProblem[] = [];
  rules.forEach((rule, index) => {
    const bad = (problem: string): void => {
      problems.push({ index, rule: rule.name, problem });
    };
    if (rule.name.trim() === '') bad('rule name is empty');
    const tools = rule.when.tool;
    if (tools !== undefined && (Array.isArray(tools) ? tools.length === 0 : tools === '')) {
      bad('`when.tool` is empty, so this rule can never match');
    }
    const risks = rule.when.risk;
    if (risks !== undefined) {
      for (const risk of asArray(risks)) {
        if (!RISKS.includes(risk)) bad(`unknown risk ${JSON.stringify(risk)}`);
      }
      if (asArray(risks).length === 0) bad('`when.risk` is empty, so this rule can never match');
    }
    if (rule.when.path !== undefined) {
      if (GLOB_CHARS.test(rule.when.path)) {
        bad(`\`when.path\` is a glob (${rule.when.path}); only absolute literal paths are supported`);
      } else if (!/^([\\/]|[A-Za-z]:[\\/])/.test(rule.when.path)) {
        bad(`\`when.path\` is not absolute (${rule.when.path})`);
      } else if (hasTrailingSeparator(rule.when.path) && trimTrailingSeparators(rule.when.path) === '') {
        bad('`when.path` is the filesystem root, which matches everything');
      }
    }
    if (rule.when.command !== undefined && rule.when.command.trim() === '') {
      bad('`when.command` is empty, so this rule can never match a command');
    }
  });
  return problems;
}

// Deny beats ask, ask beats allow; within one verdict the first rule wins. An
// action no rule matches is asked about, never silently allowed.
export function decide(request: ActionRequest, rules: readonly Rule[]): Decision {
  const hits = rules.filter((rule) => matchesWhen(rule.when, request));
  for (const verdict of PRECEDENCE) {
    const hit = hits.find((rule) => rule.verdict === verdict);
    if (hit) return { verdict, rule: hit.name, reason: hit.reason ?? null };
  }
  return { verdict: 'ask', rule: 'no-rule-matched', reason: `no rule covers ${request.name}` };
}
