// Pure terminal capability detection. All inputs are injected (env + TTY
// flags) so the logic is fully unit-testable with no process globals.

export function detectCapabilities({ env = {}, stdinIsTTY = false, stdoutIsTTY = false } = {}) {
  const isTTY = stdinIsTTY && stdoutIsTTY;
  const term = env.TERM || '';

  let colors = '16';
  if (env.NO_COLOR !== undefined || env.CI !== undefined || !isTTY) {
    colors = 'none';
  } else if (
    /truecolor|24bit/i.test(env.COLORTERM || '') ||
    env.WT_SESSION !== undefined ||
    env.TERM_PROGRAM !== undefined
  ) {
    colors = '24bit';
  } else if (term.includes('256')) {
    colors = '256';
  }

  const altScreen = isTTY && term !== 'dumb';
  const modernTerminal =
    env.WT_SESSION !== undefined ||
    env.TERM_PROGRAM !== undefined ||
    (term !== '' && term !== 'dumb');
  const osc8 = altScreen && modernTerminal;

  return { colors, altScreen, osc8 };
}
