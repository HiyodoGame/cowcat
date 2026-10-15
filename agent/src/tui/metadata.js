// Composer metadata line: one row directly above the input box showing
// `agent · model · variant` (modeled on Open Code's prompt metadata row).
// Narrow terminals degrade: under 44 columns the agent and variant slots drop
// and the remainder is truncated to the width budget.
import { truncateAnsi, visibleLen } from './render.js';

export const METADATA_NARROW_WIDTH = 44;

// Build the plain-text segments. Missing slots are omitted; a present variant
// is flagged so the caller can paint it warning+bold.
export function metadataLayout({ agent = null, model = '', variant = null } = {}, width) {
  const parts = [];
  if (agent) parts.push({ text: String(agent), kind: 'agent' });
  if (model) parts.push({ text: String(model), kind: 'model' });
  if (variant) parts.push({ text: String(variant), kind: 'variant' });
  // width budget: separators cost 3 visible cols each (" · ")
  const sep = ' · ';
  const budget = (list) => list.reduce((n, p) => n + visibleLen(p.text), 0) + sep.length * (list.length - 1);
  let chosen = parts;
  if (width < METADATA_NARROW_WIDTH) {
    // narrow mode: keep the model slot only
    chosen = parts.filter((p) => p.kind === 'model');
  }
  while (chosen.length > 1 && budget(chosen) > width) {
    // drop the least important slot until the layout fits
    const dropIdx = chosen.findIndex((p) => p.kind === 'agent');
    chosen = chosen.filter((_, i) => i !== (dropIdx === -1 ? 0 : dropIdx));
  }
  return { parts: chosen, truncated: chosen.length < parts.length };
}

// Render the metadata row. Variant slots get the warning color + bold;
// everything else is dim. Returns '' when there is nothing to show.
export function metadataLine(meta, width, theme = null, colors = true) {
  if (width < 1) return '';
  const { parts } = metadataLayout(meta, width);
  if (!parts.length) return '';
  const dim = (s) => (colors && theme?.inactive ? `${theme.inactive}${s}\x1b[0m` : s);
  const warn = (s) => (colors && theme?.warning ? `\x1b[1m${theme.warning}${s}\x1b[0m` : s);
  const styled = parts.map((p) => (p.kind === 'variant' ? warn(p.text) : dim(p.text)));
  const sep = dim(' · ');
  const line = styled.join(sep);
  return visibleLen(line) > width ? truncateAnsi(line, width) : line;
}
