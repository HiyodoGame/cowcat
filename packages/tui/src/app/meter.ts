/**
 * The status-bar meter helpers (ADR-131) and the approval-card text sanitizer
 * (ADR-129 security review P2-2). Pure functions, no view dependency, so both the
 * tests and the renderers use the same arithmetic and the same scrub.
 */

export interface MeterUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export interface MeterPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number | undefined;
  readonly cacheCreation?: number | undefined;
}

/**
 * USD for a usage total under a price table. Rates the table does not declare count
 * as zero — the only way a number can say "this report is partial". The mirror of the
 * kernel's PriceTable contract: no price, no cost line, never an invented one.
 */
export function costOf(usage: MeterUsage, price: MeterPrice): number {
  const per = (tokens: number, rate: number | undefined): number => (tokens * (rate ?? 0)) / 1_000_000;
  return (
    per(usage.input, price.input) +
    per(usage.output, price.output) +
    per(usage.cacheRead, price.cacheRead) +
    per(usage.cacheCreation, price.cacheCreation)
  );
}

/** `$0.02`, `$1.20`, `$12.40` — two decimals, always, because a meter that rounds
 *  differently every row reads as noise. Below half a cent it says `<$0.01`: `$0.00`
 *  reads as "free", and a meter must never say free when it means "small". */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/**
 * Strips C0/C1 control characters and the Unicode bidi controls from text a model
 * wrote before it reaches the screen (security review P2-2). A justification or a
 * command containing ESC/bidi can make the card show a different sentence than the
 * one the grant key will record — the card and the key must be the same words.
 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}
