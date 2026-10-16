import type { ToolRisk } from '../ports/index.js';

export type Verdict = 'allow' | 'ask' | 'deny';

export interface ActionRequest {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly risk: ToolRisk;
}

export interface Rule {
  readonly name: string;
  readonly matches: (request: ActionRequest) => boolean;
  readonly verdict: Verdict;
  readonly reason?: string;
}

export interface Decision {
  readonly verdict: Verdict;
  readonly rule: string;
  readonly reason: string | null;
}

const PRECEDENCE: readonly Verdict[] = ['deny', 'ask', 'allow'];

// Deny beats ask, ask beats allow; within one verdict the first rule wins. An
// action no rule matches is asked about, never silently allowed.
export function decide(request: ActionRequest, rules: readonly Rule[]): Decision {
  const hits = rules.filter((rule) => rule.matches(request));
  for (const verdict of PRECEDENCE) {
    const hit = hits.find((rule) => rule.verdict === verdict);
    if (hit) return { verdict, rule: hit.name, reason: hit.reason ?? null };
  }
  return { verdict: 'ask', rule: 'no-rule-matched', reason: `no rule covers ${request.name}` };
}
