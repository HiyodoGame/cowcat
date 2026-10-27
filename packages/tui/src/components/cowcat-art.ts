/**
 * The mascot (ADR-167 ③): a cow-spotted cat, in ASCII, because the left rail deserves a
 * face and the product's own name asks for one. Two frames while a turn runs (the ear
 * twitches), one still frame when idle — a mascot that animates at rest is noise.
 *
 * Pure function of (state, now): the frame snapshots stay deterministic. The frames are
 * raw lines — the rail mounts them into its own component, so no theme tokens here.
 */

const IDLE: readonly string[] = [
  '  /\\_/\\',
  ' ( ^.^ )  ~',
  '  > ~ <',
];

const RUNNING: readonly (readonly string[])[] = [
  [
    '  /\\_/\\',
    ' ( o.^ )  ~',
    '  > ^ <  /',
  ],
  [
    '  /\\_/\\',
    ' ( ^.o ) ~',
    '  > ^ <  \\',
  ],
];

export type MascotState = 'idle' | 'running';

export function mascotFrames(state: MascotState, now: number): readonly string[] {
  const frames = state === 'running' ? RUNNING : [IDLE];
  return frames[Math.floor(now / 600) % frames.length] ?? IDLE;
}
