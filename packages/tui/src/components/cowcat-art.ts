import type { TuiView } from '../app/view.js';
import type { SpriteColor } from '../ui/scene.js';

export type MascotState = 'idle' | 'thinking' | 'tools' | 'approval' | 'success' | 'failed';
type Pixel = SpriteColor | null;
type Grid = Pixel[][];

const WIDTH = 82;
const HEIGHT = 46;
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

export function mascotFrame(state: MascotState, now: number, animate = true, settledAt: number | null = 0): readonly (readonly Pixel[])[] {
  const grid = baseFrame();
  const gaze = animate && state === 'thinking' ? Math.floor(now / 600) % 3 - 1 : 0;
  const blink = animate && state === 'idle' && now % 4_200 >= 4_000;
  renderEyes(grid, state, gaze, blink);
  if (!animate) return grid;
  if (state === 'thinking') return shade(grid, (x, y) => (x + y + Math.floor(now / 600)) % 12 === 0);
  if (state === 'tools') return shade(grid, (x) => (x + Math.floor(now / 240)) % 16 === 0);
  if (state === 'idle' && Math.floor(now / 1_400) % 2 === 1) return shade(grid, () => true, true);
  if (state === 'success' && settledAt !== null && now - settledAt < 400) return shade(grid, () => true);
  return grid;
}

function baseFrame(): Grid {
  const grid = Array.from({ length: HEIGHT }, (_, y) => Array.from({ length: WIDTH }, (_, x) => baseRole(x, y)));
  return grid;
}

function baseRole(px: number, py: number): SpriteColor {
  const x = Math.min((px + 0.5) / 2, 41 - (px + 0.5) / 2);
  const y = (py + 0.5) / 2;
  const head = roundedRect(x, y, 5, 35, 6, 21, 4);
  const ears = triangle(x, y, [5, 8], [8, 1], [15, 6]);
  if (!(head || ears)) return 'backdrop';
  return roundedRect(x, y, 9, 31, 9, 19, 3) ? 'on' : 'furMid';
}

function renderEyes(grid: Grid, state: MascotState, gaze: number, blink: boolean): void {
  if (state === 'idle' && blink) {
    pair(grid, [[12, 13], [13, 13], [14, 13], [15, 13]], 'eye');
  } else if (state === 'success') {
    pair(grid, [[12, 14], [13, 13], [14, 12], [15, 13], [16, 14]], 'eye');
  } else if (state === 'failed') {
    pair(grid, [[12, 11], [13, 12], [14, 13], [15, 14]], 'eye');
  } else {
    openEyes(grid, state === 'thinking' ? gaze : 0, state === 'approval' ? 6 : state === 'tools' ? 2 : 4);
  }
  dot(grid, 20, 17, 'nose');
}

function openEyes(grid: Grid, gaze: number, height: number): void {
  for (const [index, cx] of [14 + gaze, 27 + gaze].entries()) {
    for (let y = 11; y < 13 + height; y += 1) {
      for (let x = cx - 2; x <= cx + 1; x += 1) dot(grid, x, y, 'iris');
    }
    for (let y = 12; y < 12 + height; y += 1) {
      for (let x = cx - 1; x <= cx; x += 1) dot(grid, x, y, 'eye');
    }
    dot(grid, index === 0 ? cx - 1 : cx, 12, 'highlight');
  }
}

function dot(grid: Grid, lx: number, ly: number, role: SpriteColor): void {
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      const row = grid[ly * 2 + dy];
      if (row !== undefined && lx * 2 + dx >= 0 && lx * 2 + dx < WIDTH) row[lx * 2 + dx] = role;
    }
  }
}

function pair(grid: Grid, points: readonly (readonly [number, number])[], role: SpriteColor): void {
  for (const [x, y] of points) {
    dot(grid, x, y, role);
    dot(grid, 40 - x, y, role);
  }
}

function shade(grid: Grid, active: (x: number, y: number) => boolean, dim = false): Grid {
  return grid.map((row, y) => row.map((pixel, x) => {
    if (!active(x, y)) return pixel;
    if (dim && pixel === 'furLight') return 'furMid';
    if (!dim && pixel === 'furDark') return 'furMid';
    if (!dim && pixel === 'furMid') return 'furLight';
    return pixel;
  }));
}

function roundedRect(x: number, y: number, x0: number, x1: number, y0: number, y1: number, radius: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if ((x >= x0 + radius && x <= x1 - radius) || (y >= y0 + radius && y <= y1 - radius)) return true;
  const cx = x < x0 + radius ? x0 + radius : x1 - radius;
  const cy = y < y0 + radius ? y0 + radius : y1 - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function triangle(x: number, y: number, a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): boolean {
  const sign = (p1: readonly [number, number], p2: readonly [number, number], p3: readonly [number, number]): number => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const p = [x, y] as const;
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
