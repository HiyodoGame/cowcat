import type { SpriteColor } from './scene.js';

export interface QuadrantCell {
  readonly glyph: string;
  readonly foreground: SpriteColor | null;
  readonly background: SpriteColor | null;
}

const GLYPHS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const;
const PRIORITY: readonly SpriteColor[] = ['eye', 'nose', 'iris', 'highlight', 'on', 'furLight', 'furMid', 'furDark'];

export function quadrantCell(pixels: readonly (readonly (SpriteColor | null)[])[], x: number, y: number): QuadrantCell {
  const column = x * 2;
  const points = [pixels[y * 2]?.[column] ?? null, pixels[y * 2]?.[column + 1] ?? null, pixels[y * 2 + 1]?.[column] ?? null, pixels[y * 2 + 1]?.[column + 1] ?? null];
  const colors = points.filter((pixel): pixel is SpriteColor => pixel !== null && pixel !== 'backdrop');
  if (colors.length === 0) return points.includes('backdrop')
    ? { glyph: '▪', foreground: 'backdrop', background: null }
    : { glyph: ' ', foreground: null, background: null };

  const ranked = [...new Set(colors)].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
  const foreground = ranked[0] ?? 'on';
  if (points.some((pixel) => pixel === null || pixel === 'backdrop') || ranked.length === 1) {
    const mask = maskOf(points, foreground);
    return { glyph: GLYPHS[mask] ?? ' ', foreground, background: null };
  }
  const background = ranked[1] ?? null;
  return { glyph: GLYPHS[maskOf(points, foreground)] ?? ' ', foreground, background };
}

function maskOf(points: readonly (SpriteColor | null)[], foreground: SpriteColor): number {
  return points.reduce((mask, pixel, index) => mask | (pixel === foreground ? 1 << index : 0), 0);
}
