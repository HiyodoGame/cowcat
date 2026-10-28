import type { TokenName } from '../theme/tokens.js';
import type { Line } from './line.js';

export type SpriteColor = 'fur' | 'patch' | 'nose' | 'eye';

interface NodeBase {
  readonly key: string;
}

export interface TextNode extends NodeBase {
  readonly kind: 'text';
  readonly rows: readonly Line[];
}

export interface ScrollTextNode extends NodeBase {
  readonly kind: 'scrolltext';
  readonly rows: readonly Line[];
}

export interface StackNode extends NodeBase {
  readonly kind: 'stack';
  readonly children: readonly SceneNode[];
  readonly gap: number;
}

export interface BlockNode extends NodeBase {
  readonly kind: 'block';
  readonly children: readonly SceneNode[];
  readonly tone: TokenName;
  readonly hit?: string;
}

export interface PanelNode extends NodeBase {
  readonly kind: 'panel';
  readonly title: string;
  readonly tone: TokenName;
  readonly children: readonly SceneNode[];
  /** Actions stay mounted below a scrollable body, such as approval choices. */
  readonly actions?: readonly SceneNode[];
  readonly rail?: boolean;
  readonly hit?: string;
}

export interface ChoiceNode extends NodeBase {
  readonly kind: 'choice';
  readonly text: string;
  readonly selected: boolean;
  readonly token: TokenName;
  readonly hit?: string;
}

export interface StatusFact {
  readonly label: string;
  readonly value: string;
}

export interface StatusNode extends NodeBase {
  readonly kind: 'status';
  readonly activity: string;
  readonly facts: readonly StatusFact[];
  readonly token: TokenName;
}

export interface SpriteNode extends NodeBase {
  readonly kind: 'sprite';
  readonly pixels: readonly (readonly (SpriteColor | null)[])[];
}

export interface SceneImage {
  readonly source: Uint8Array;
  readonly label: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ImageNode extends NodeBase {
  readonly kind: 'image';
  readonly image: SceneImage;
}

export type SceneNode = TextNode | ScrollTextNode | StackNode | BlockNode | PanelNode | ChoiceNode | StatusNode | SpriteNode | ImageNode;

export function textBlock(key: string, rows: readonly Line[]): TextNode {
  return { kind: 'text', key, rows };
}

export function scrollTextBlock(key: string, rows: readonly Line[]): ScrollTextNode {
  return { kind: 'scrolltext', key, rows };
}

export function stackBlock(key: string, children: readonly SceneNode[], gap = 0): StackNode {
  return { kind: 'stack', key, children, gap };
}

export function accentBlock(key: string, tone: TokenName, children: readonly SceneNode[], hit?: string): BlockNode {
  return { kind: 'block', key, tone, children, ...(hit === undefined ? {} : { hit }) };
}

export function panelBlock(options: {
  readonly key: string;
  readonly title: string;
  readonly tone: TokenName;
  readonly children: readonly SceneNode[];
  readonly actions?: readonly SceneNode[];
  readonly rail?: boolean;
  readonly hit?: string;
}): PanelNode {
  return { kind: 'panel', ...options };
}

export function choiceBlock(key: string, text: string, options: {
  readonly selected?: boolean;
  readonly token?: TokenName;
  readonly hit?: string;
} = {}): ChoiceNode {
  return {
    kind: 'choice', key, text, selected: options.selected ?? false, token: options.token ?? 'text',
    ...(options.hit === undefined ? {} : { hit: options.hit }),
  };
}

export function statusBlock(key: string, activity: string, facts: readonly StatusFact[], token: TokenName): StatusNode {
  return { kind: 'status', key, activity, facts, token };
}

export function spriteBlock(key: string, pixels: readonly (readonly (SpriteColor | null)[])[]): SpriteNode {
  return { kind: 'sprite', key, pixels };
}

export function imageBlock(key: string, image: SceneImage): ImageNode {
  return { kind: 'image', key, image };
}

export function heightOf(node: SceneNode): number {
  switch (node.kind) {
    case 'text':
    case 'scrolltext': return node.rows.length;
    case 'stack': return node.children.reduce((sum, child, index) => sum + heightOf(child) + (index === 0 ? 0 : node.gap), 0);
    case 'block': return Math.max(1, node.children.reduce((sum, child) => sum + heightOf(child), 0));
    case 'panel': return [...node.children, ...(node.actions ?? [])].reduce((sum, child) => sum + heightOf(child), 0) + 2;
    case 'sprite': return Math.ceil(node.pixels.length / 2);
    case 'image': return node.image.rows;
    case 'choice':
    case 'status': return 1;
  }
}
