import { mascotState } from '../components/cowcat-art.js';
import type { TuiView } from './view.js';

export function activityDelay(view: TuiView, now: number, catVisible: boolean, animationsEnabled: boolean): number | null {
  if (!animationsEnabled) return null;
  const remaining = Array.from(view.reasoningStream).length - view.reasoningShown;
  if (remaining > 0) return 200;
  if (!catVisible) return null;
  if (mascotState(view, now) !== 'idle') return 200;
  const phase = now % 4_200;
  return Math.max(1, phase < 4_000 ? 4_000 - phase : 4_200 - phase);
}
