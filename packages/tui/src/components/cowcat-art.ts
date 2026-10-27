import type { TuiView } from '../app/view.js';
import type { SpriteColor } from '../ui/scene.js';

export type MascotState = 'idle' | 'thinking' | 'tools' | 'approval' | 'success' | 'failed';
type Pixel = SpriteColor | null;
type Grid = Pixel[][];

const WIDTH = 24;
const HEIGHT = 16;
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
  const frame = animate && state === 'thinking' ? Math.floor(now / 240) % 2 : 0;
  const wag = animate && (state === 'tools' || state === 'success') ? Math.floor(now / 200) % 2 : 0;
  const blink = animate && state === 'idle' && Math.floor(now / 100) % 42 >= 40;
  const grid = Array.from({ length: HEIGHT }, () => Array<Pixel>(WIDTH).fill(null));
  const tail = wag === 0 ? 0 : 1;
  for (const [x, y] of [[21, 13], [22, 12], [22, 11 - tail], [21, 10 - tail], [20, 10 - tail]] as const) {
    paint(grid, x, y, 'patch');
    if (y > 10) paint(grid, x - 1, y, 'fur');
  }
  ellipse(grid, 12, 12, 8, 4, 'patch');
  ellipse(grid, 11, 12, 6, 4, 'fur');
  ellipse(grid, 17, 13, 3, 2, 'patch');
  ellipse(grid, 7, 14, 3, 2, 'fur');
  ellipse(grid, 15, 14, 3, 2, 'fur');
  const earBase = state === 'failed' ? 2 : 0;
  for (let y = 0; y < 6; y += 1) {
    for (let x = 3 - y; x <= 7 + y; x += 1) paint(grid, x, y + earBase, 'patch');
    for (let x = 20 + y; x >= 16 - y; x -= 1) paint(grid, x, y + earBase, 'patch');
  }
  for (let y = 1; y < 5; y += 1) {
    for (let x = 4 - y; x <= 6 + y; x += 1) paint(grid, x, y + earBase, 'fur');
    for (let x = 19 + y; x >= 17 - y; x -= 1) paint(grid, x, y + earBase, 'fur');
  }
  paint(grid, 4, 2 + earBase, 'nose');
  paint(grid, 18, 2 + earBase, 'nose');
  ellipse(grid, 12, 7, 10, 6, 'patch');
  ellipse(grid, 12, 7, 9, 5, 'fur');
  ellipse(grid, 7, 5, 4, 3, 'patch');
  ellipse(grid, 19, 7, 3, 3, 'patch');
  ellipse(grid, 10, 9, 4, 2, 'fur');
  ellipse(grid, 14, 9, 4, 2, 'fur');
  const gaze = state === 'thinking' ? frame : 0;
  if (blink) {
    paint(grid, 8, 7, 'patch');
    paint(grid, 16, 7, 'patch');
  } else {
    paint(grid, 8 + gaze, 7, 'eye');
    paint(grid, 16 + gaze, 7, 'eye');
    if (state === 'approval') {
      paint(grid, 8, 6, 'eye');
      paint(grid, 16, 6, 'eye');
    }
  }
  paint(grid, 12, 9, 'nose');
  paint(grid, 13, 9, 'nose');
  paint(grid, 12, 11, 'patch');
  if (state !== 'failed') {
    paint(grid, 11, 10, 'patch');
    paint(grid, 14, 10, 'patch');
  }
  for (const x of [3, 4, 5, 18, 19, 20]) paint(grid, x, 10, 'patch');
  if (state === 'success' && animate) return [...grid.slice(1), Array<Pixel>(WIDTH).fill(null)];
  return grid;
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
