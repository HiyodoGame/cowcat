import type { TokenName } from '../theme/tokens.js';

/**
 * A line of the interface, before any renderer sees it.
 *
 * The components produce these; `ui/` turns them into renderables. That split is what lets
 * the interesting half — "what does the screen say?" — be a pure function of the view model,
 * testable with no terminal at all, while the uninteresting half stays a thin adapter over
 * opentui (ADR-066 ②).
 *
 * `token` is a theme token, never a colour: the renderer resolves it once. A component that
 * carried `#A8C34A` would put a brand decision in a place that cannot be re-themed.
 */
/** One styled span of a row (ADR-162): markdown inline runs mount one span each. */
export interface LineRun {
  readonly text: string;
  readonly token: TokenName;
  readonly bold?: boolean;
}

export interface Line {
  readonly text: string;
  readonly token: TokenName;
  readonly bold: boolean;
  /**
   * Rich spans for this row (ADR-162), present only when the row mixes styles — a plain
   * row is just `text`+`token`. `text` stays the full concatenation: width checks, the
   * mount diff and the frame snapshots all read the plain string.
   */
  readonly runs?: readonly LineRun[];
  /**
   * What a click on this row means, as an opaque id the loop decodes.
   *
   * The UI layer must not know about tool cards or approvals, so it carries a string and
   * the composition root (`run.ts`) decides what `tool:<id>` or `approval:<n>` does.
   */
  readonly hit?: string;
}

export function line(text: string, token: TokenName = 'text', bold = false, hit?: string): Line {
  return hit === undefined ? { text, token, bold } : { text, token, bold, hit };
}

/** A row from styled spans: `text` is the concatenation, so every plain-text consumer is unaffected. */
export function runLine(prefix: string, runs: readonly LineRun[], suffix: string, hit?: string): Line {
  const text = prefix + runs.map((span) => span.text).join('') + suffix;
  const full: readonly LineRun[] = [
    ...(prefix === '' ? [] : [{ text: prefix, token: 'text' as const }]),
    ...runs,
    ...(suffix === '' ? [] : [{ text: suffix, token: 'text' as const }]),
  ];
  return hit === undefined ? { text, token: 'text', bold: false, runs: full } : { text, token: 'text', bold: false, runs: full, hit };
}

/** One `Line` per source line, with a marker on the first and padding afterwards. */
export function marked(text: string, marker: string, token: TokenName, indent = ' ', bold = false): readonly Line[] {
  const rows = text.split('\n');
  const padding = ' '.repeat(marker.length);
  return rows.map((row, index) => line(`${index === 0 ? marker : index === 1 ? indent : padding}${row}`, token, bold));
}

/** Text lines, indented, for a block that belongs to the entry above it. */
export function block(text: string, token: TokenName, indent: number, bold = false): readonly Line[] {
  const prefix = ' '.repeat(indent);
  return text.split('\n').map((row) => line(`${prefix}${row}`, token, bold));
}

/**
 * The tail of a block, which is what the brand guide asks a terminal-output card to show
 * ("默认折叠，显示退出码 + 尾部 3 行" — §4.2). The rest is still in the session log.
 */
export function tail(text: string, token: TokenName, indent: number, count: number): readonly Line[] {
  const rows = text.split('\n').filter((row) => row !== '');
  const kept = rows.slice(-count);
  const dropped = rows.length - kept.length;
  const lines = block(kept.join('\n'), token, indent);
  // Saying what was folded away, rather than pretending the output was three lines long.
  return dropped > 0 ? [line(`${' '.repeat(indent)}… 上面还有 ${String(dropped)} 行`, 'textDim'), ...lines] : lines;
}
