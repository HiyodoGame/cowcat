import type { Rule } from '../policy/decide.js';
import type { SubagentRole, ToolPort } from '../ports/index.js';

/**
 * The read-only role's tool set (ADR-081 ①).
 *
 * Three tools, chosen because they can answer "where is it / what does it say" without
 * any way to change the answer. `Bash` is deliberately absent: a shell is not read-only
 * just because the prompt says so.
 */
const EXPLORE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/**
 * Never given to a child, whatever the role (ADR-081 ①).
 *
 * `Task` is not in the parent's tool map at all (it is the kernel's own tool, ADR-080),
 * so the rule below is belt-and-braces; `TodoWrite` is real, and a child's full-replace
 * todo list would overwrite the parent's (ADR-054).
 */
const NEVER_GIVEN: readonly string[] = ['Task', 'TodoWrite'];

/**
 * The tools one child may use.
 *
 * `general` is defined as "the parent's tools minus what a child may never have" rather
 * than as a list of its own: a list would silently miss every tool added later.
 */
export function toolsForRole(tools: ReadonlyMap<string, ToolPort>, role: SubagentRole): ReadonlyMap<string, ToolPort> {
  const allowed = role === 'explore' ? new Set(EXPLORE_TOOLS) : null;
  return new Map(
    [...tools].filter(([name]) => {
      if (NEVER_GIVEN.includes(name)) return false;
      return allowed === null || allowed.has(name);
    }),
  );
}

/**
 * The rules a child runs with: the parent's, plus denials that only narrow (ADR-081 ②).
 *
 * The rule language has no negation, so an allowlist has to be expressed as one `deny` per
 * tool that falls outside it. That is more verbose than a `when.tool: !allowed` would be,
 * and it is the only shape the existing matcher can honour — inventing a second matcher
 * here is exactly what ADR-027 forbids.
 */
export function rulesForRole(
  rules: readonly Rule[],
  tools: ReadonlyMap<string, ToolPort>,
  role: SubagentRole,
): readonly Rule[] {
  const denied = new Set<string>(NEVER_GIVEN);
  if (role === 'explore') {
    for (const name of tools.keys()) {
      if (!EXPLORE_TOOLS.includes(name)) denied.add(name);
    }
  }
  return [
    ...rules,
    ...[...denied].map((name) => ({
      name: `subagent-denies-${name}`,
      when: { tool: name },
      verdict: 'deny' as const,
    })),
  ];
}
