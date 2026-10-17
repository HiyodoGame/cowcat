import type { Rule } from './decide.js';

// The P0 minimum set (ADR-027 replaces the old function-shaped rule with data).
// Note there is no `deny` rule here: the deny arm of PRECEDENCE is unreachable
// with the shipped defaults and only tests reach it (see the probe case P10 in
// docs/research/p3-policy.md).
export const DEFAULT_RULES: readonly Rule[] = [
  { name: 'reads-are-free', when: { risk: 'read' }, verdict: 'allow' },
  {
    name: 'mutations-need-approval',
    when: { risk: ['write', 'exec', 'network'] },
    verdict: 'ask',
    reason: 'this action changes state outside the conversation',
  },
];
