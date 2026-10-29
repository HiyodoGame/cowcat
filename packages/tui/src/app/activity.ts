import { mascotState } from '../components/cowcat-art.js';
import type { TuiView } from './view.js';

export function activityDelay(view: TuiView, now: number, catVisible: boolean, animationsEnabled: boolean): number | null {
  if (!animationsEnabled) return null;
  const remaining = Array.from(view.reasoningStream).length - view.reasoningShown;
  if (remaining > 0) return 200;
  if (!catVisible) return null;
  const state = mascotState(view, now);
  switch (state) {
    case 'thinking': return untilPhase(now, 600);
    case 'tools': return untilPhase(now, 240);
    case 'success': {
      const elapsed = now - (view.turnSettledAt ?? now);
      if (elapsed < 400) return 400 - elapsed;
      return Math.max(1, 1_600 - elapsed);
    }
    case 'failed': return Math.max(1, 1_600 - (now - (view.turnSettledAt ?? now)));
    case 'approval': return null;
    case 'idle': return Math.min(untilPhase(now, 1_400), untilPhase(now, 4_200, 4_000), untilPhase(now, 6_000, 5_200), untilPhase(now, 6_000));
  }
}

function untilPhase(now: number, period: number, offset = 0): number {
  const remaining = (offset - (now % period) + period) % period;
  return remaining === 0 ? period : remaining;
}
