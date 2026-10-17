import type { Rule } from './decide.js';

// The P0 minimum set (ADR-027 replaces the old function-shaped rule with data).
//
// There is exactly one rule, and the missing second one is deliberate. A rule like
// `{ when: { risk: ['write', 'exec', 'network'] }, verdict: 'ask' }` looks harmless
// and is not: `decide` ranks by CATEGORY (deny > ask > allow, ADR-023), so a
// catch-all `ask` **shadows every `allow`**. Nothing could ever permit a write,
// which makes the P3 exit criterion — "every verdict can be expressed in
// configuration" — unsatisfiable, and makes the trust gate meaningless besides.
//
// The prompt for a mutating action is what `decide` already returns when no rule
// matches (`no-rule-matched` → ask). That is the right place for it: a DEFAULT, not
// a rule. The external reference is built the same way — its prompt is the default
// and its allow rules do take effect.
//
// Kept in tests so the two stay in step: test/trust.test.ts asserts that an `allow`
// for a write is reachable, which is exactly what this rule would have prevented.
export const DEFAULT_RULES: readonly Rule[] = [
  { name: 'reads-are-free', when: { risk: 'read' }, verdict: 'allow' },
];
