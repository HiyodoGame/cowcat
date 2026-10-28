import type { TuiView } from '../app/view.js';
import type { SpriteColor } from '../ui/scene.js';

export type MascotState = 'idle' | 'thinking' | 'tools' | 'approval' | 'success' | 'failed';
type Pixel = SpriteColor | null;
type Grid = Pixel[][];

const WIDTH = 28;
const HEIGHT = 20;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function mascotState(view: TuiView, now: number): MascotState {
  if (view.approval !== null && view.approval.verdict === null) return 'approval';
  const state = view.turn?.state;
  if (state === 'awaiting_tools' || view.pendingTools.length > 0 || view.tasks.some((task) => task.state === 'running') || view.agents.some((agent) => agent.state === 'running')) return 'tools';
  if (state !== undefined && !TERMINAL.has(state)) return 'thinking';
  if (view.turnSettledAt !== null && now - view.turnSettledAt < 1_600) {
    if (state === 'completed') return 'success';
    if (state === 'failed') return 'failed';
  }
  return 'idle';
}

export function mascotFrame(state: MascotState, now: number, animate = true): readonly (readonly Pixel[])[] {
  const grid = head(state);
  const gaze = animate && state === 'thinking' ? Math.floor(now / 600) % 3 - 1 : animate && state === 'idle' && now % 6_000 >= 5_200 ? 1 : 0;
  const blink = animate && state === 'idle' && now % 4_200 >= 4_000;
  eyes(grid, state, gaze, blink);
  if (state === 'tools' && animate) {
    const frame = Math.floor(now / 240) % 2;
    paint(grid, 22, 1, frame === 0 ? 'fur' : 'patch');
    paint(grid, 20, 16, frame === 0 ? 'fur' : 'patch');
  }
  if (state === 'success' && animate && now % 800 < 400) return [...grid.slice(1), Array<Pixel>(WIDTH).fill(null)];
  if (state === 'failed' && animate) {
    const shift = Math.floor(now / 180) % 2 === 0 ? -1 : 1;
    return grid.map((row) => shift < 0 ? [...row.slice(1), null] : [null, ...row.slice(0, -1)]);
  }
  if (state === 'idle' && animate && Math.floor(now / 1_400) % 2 === 1) {
    return grid.map((row, y) => y >= 3 ? (grid[y + 1] ?? Array<Pixel>(WIDTH).fill(null)) : row);
  }
  return grid;
}

function head(state: MascotState): Grid {
  const grid = Array.from({ length: HEIGHT }, () => Array<Pixel>(WIDTH).fill(null));
  ellipse(grid, 15, 11, 10.5, 8, 'patch');
  ellipse(grid, 15, 10.5, 9.5, 7.5, 'fur');
  const base = state === 'failed' ? 2 : 0;
  for (let y = 0; y < 6; y += 1) {
    for (let x = 6 - y; x <= 9 + y; x += 1) paint(grid, x, y + base, 'patch');
    for (let x = 22 + y; x >= 18 - y; x -= 1) paint(grid, x, y + base, 'fur');
  }
  paint(grid, 26, 5, 'patch');
  paint(grid, 25, 4, 'patch');
  ellipse(grid, 6, 5, 3, 2, 'patch');
  ellipse(grid, 22, 6, 2.5, 2.3, 'patch');
  ellipse(grid, 8, 14, 2, 1, 'nose');
  paint(grid, 15, 14, 'nose');
  paint(grid, 16, 14, 'nose');
  paint(grid, 16, 17, 'patch');
  paint(grid, 24, 3, 'eye');
  if (state !== 'failed') {
    paint(grid, 15, 16, 'patch');
    paint(grid, 18, 15, 'patch');
  } else {
    paint(grid, 10, 9, 'patch');
    paint(grid, 20, 9, 'patch');
  }
  return grid.map((row, y) => {
    const shift = Math.round((10 - y) / 4);
    return shift > 0 ? [...Array<Pixel>(shift).fill(null), ...row.slice(0, -shift)] : [...row.slice(-shift), ...Array<Pixel>(-shift).fill(null)];
  });
}

function eyes(grid: Grid, state: MascotState, gaze: number, blink: boolean): void {
  if (blink) {
    paint(grid, 11, 11, 'patch');
    paint(grid, 20, 11, 'patch');
    paint(grid, 11, 10, 'patch');
    paint(grid, 20, 10, 'patch');
    return;
  }
  if (state === 'success') {
    for (const [x, y] of [[10, 11], [11, 10], [19, 10], [20, 11]] as const) paint(grid, x, y, 'patch');
    return;
  }
  const radius = state === 'approval' ? 1.8 : 1.3;
  ellipse(grid, 11 + gaze, 11, radius, 1.7, 'patch');
  ellipse(grid, 20 + gaze, 11, radius, 1.7, 'patch');
  paint(grid, 11 + gaze, 10, 'fur');
  paint(grid, 20 + gaze, 10, 'fur');
}

function paint(grid: Grid, x: number, y: number, color: SpriteColor): void {
  const row = grid[y];
  if (row !== undefined && x >= 0 && x < WIDTH) row[x] = color;
}

function ellipse(grid: Grid, cx: number, cy: number, rx: number, ry: number, color: SpriteColor): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) paint(grid, x, y, color);
    }
  }
}
