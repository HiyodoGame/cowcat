// Assistant-turn footer + status line formatters (modeled on Open Code's
// message footer): one muted line closing each assistant turn, plus retry and
// error one-liners. Pure functions — the UI paints them with the theme.

// Turn footer: `✻ for 3s · model · 42 tok/s` (muted). tok/s is omitted when
// no token count is available — the loop's duck interface does not deliver
// usage to the UI, so the segment only appears when a caller supplies it.
export function footerLine({ model = '', seconds = 0, tokensPerSec = null } = {}) {
  const dur = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
  const parts = [`✻ for ${dur}`];
  if (model) parts.push(String(model));
  if (tokensPerSec != null && Number.isFinite(tokensPerSec)) parts.push(`${Math.round(tokensPerSec)} tok/s`);
  return parts.join(' · ');
}

// Retry countdown: `⚠ Retrying in 3s · attempt 2`.
export function retryLine({ seconds = 0, attempt = 1 } = {}) {
  return `⚠ Retrying in ${seconds}s · attempt ${attempt}`;
}

// Model error one-liner (red when painted by the caller).
export function errorLine(message) {
  return `✗ ${String(message).split('\n')[0].slice(0, 160)}`;
}

// Thinking block summary: `Thought · 1.2s` (muted when painted). Reserved
// slot — the provider layer does not stream reasoning deltas to the UI yet.
export function thinkingSummary(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const dur = s < 60 ? `${Math.round(s * 10) / 10}s` : `${Math.round(s / 60)}m`;
  return `Thought · ${dur}`;
}
