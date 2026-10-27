import { line, type Line } from '../ui/line.js';

/**
 * The mascot (ADR-167 ③): a cow-spotted cat, in ASCII, because the left rail deserves a
 * face and the product's own name asks for one. Two frames while a turn runs (the ear
 * twitches), one still frame when idle — a mascot that animates at rest is noise.
 *
 * Pure function of (state, now): the frame snapshots stay deterministic.
 */

const IDLE: readonly string[] = [
  '  /\\_/\\',
  ' ( ^.^ )  ~',
  '  > ~ <',
];

const RUNNING: readonly (readonly string[])[] = [
  [
    '  /\\_/\\',
    ' ( •.^ )  ~',
    '  > ^ <  /',
  ],
  [
    '  /\\_/\\',
    ' ( ^.• ) ~',
    '  > ^ <  \\',
  ],
];

export type MascotState = 'idle' | 'running';

export function cowCatArt(state: MascotState, now: number): readonly Line[] {
  const frames = state === 'running' ? RUNNING : [IDLE];
  const frame = frames[Math.floor(now / 600) % frames.length] ?? IDLE;
  return frame.map((row, index) => line(row, index === 1 ? 'brand' : 'textDim'));
}
