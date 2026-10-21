/**
 * TUI preferences that come from the environment, as pure functions.
 *
 * They live here rather than inline in `run.ts` so the defaults are a table a test can
 * read: "mouse is on unless you turn it off" is a decision, and the last round shipped
 * click handlers that never fired because the renderer was never told to capture the
 * mouse at all.
 */
export function mouseEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['COWCAT_MOUSE'] !== 'off';
}

export function animationsEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['COWCAT_ANIMATIONS'] !== 'off';
}

/** Lines per wheel notch. Three matches vim and opencode's default (ADR-099). */
export function scrollStep(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env['COWCAT_SCROLL_SPEED'] ?? '3');
  if (!Number.isFinite(raw)) return 3;
  return Math.min(20, Math.max(1, Math.round(raw)));
}
