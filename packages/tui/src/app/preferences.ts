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
