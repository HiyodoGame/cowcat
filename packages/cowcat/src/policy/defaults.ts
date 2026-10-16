import type { Rule } from './decide.js';

export const DEFAULT_RULES: readonly Rule[] = [
  { name: 'reads-are-free', matches: (r) => r.risk === 'read', verdict: 'allow' },
  {
    name: 'mutations-need-approval',
    matches: (r) => r.risk === 'write' || r.risk === 'exec' || r.risk === 'network',
    verdict: 'ask',
    reason: 'this action changes state outside the conversation',
  },
];
