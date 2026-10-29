import type { SpriteColor } from './scene.js';

export interface BrailleCell {
  readonly glyph: string;
  readonly foreground: SpriteColor | null;
  readonly background: null;
}

const PRIORITY: readonly SpriteColor[] = ['eye', 'nose', 'iris', 'highlight', 'on', 'furLight', 'furMid', 'furDark', 'backdrop'];
const BITS = [1, 8, 2, 16, 4, 32, 64, 128] as const;

export function brailleCell(pixels: readonly (readonly (SpriteColor | null)[])[], x: number, y: number): BrailleCell {
  const points = Array.from({ length: 8 }, (_, index) => pixels[y * 4 + Math.floor(index / 2)]?.[x * 2 + (index % 2)] ?? null);
  const colors = points.filter((pixel): pixel is SpriteColor => pixel !== null);
  if (colors.length === 0) return { glyph: ' ', foreground: null, background: null };
  const foreground = [...new Set(colors)].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0] ?? 'on';
  const mask = points.reduce((value, pixel, index) => value | (pixel === foreground ? BITS[index] ?? 0 : 0), 0);
  return { glyph: String.fromCodePoint(0x2800 + mask), foreground, background: null };
}
