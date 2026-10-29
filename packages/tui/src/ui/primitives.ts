import {
  BoxRenderable,
  ImageRenderable,
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  createTextAttributes,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core';
import { colorOf, type Theme, type TokenName } from '../theme/tokens.js';
import { heightOf, type SceneNode, type SpriteNode, type StatusNode } from './scene.js';
import type { Line } from './line.js';
import { mountScrollText } from './scroll-text.js';
import { quadrantCell } from './quadrants.js';

export interface SceneContext {
  readonly renderer: CliRenderer;
  readonly theme: Theme;
  readonly onHit: (id: string) => void;
}

export interface SceneBinding {
  readonly renderable: BoxRenderable;
  readonly node: SceneNode;
  resize?(height: number): void;
  update(node: SceneNode): void;
}

const BOLD = createTextAttributes({ bold: true });

export function resolveToken(theme: Theme, token: TokenName): string | RGBA {
  const value = colorOf(theme, token);
  return value === null ? RGBA.defaultForeground() : value;
}

export function styledOf(spec: Line, theme: Theme): string | StyledText {
  if (spec.runs === undefined || spec.runs.length === 0) return spec.text;
  return new StyledText(spec.runs.map((run): TextChunk => {
    const color = resolveToken(theme, run.token);
    return {
      __isChunk: true,
      text: run.text,
      ...(typeof color === 'string' ? { fg: RGBA.fromHex(color) } : {}),
      ...(run.bold === true ? { attributes: BOLD } : {}),
    };
  }));
}

export function mountScene(context: SceneContext, parent: BoxRenderable, node: SceneNode, index?: number): SceneBinding {
  if (node.kind === 'scrolltext') return mountScrollText(context, parent, node, index);
  const { renderer } = context;
  const root = new BoxRenderable(renderer, {
    id: `scene-${node.kind}-${node.key}`,
    width: '100%',
    height: heightOf(node),
    flexShrink: 0,
    flexDirection: 'column',
  });
  parent.add(root, index);
  let binding: SceneBinding;
  const hit = (id: string | undefined): void => {
    root.onMouseDown = id === undefined ? undefined : () => { context.onHit(id); };
  };
  switch (node.kind) {
    case 'text': {
      root.overflow = 'hidden';
      const rows: TextRenderable[] = [];
      const update = (next: typeof node): void => {
        for (const extra of rows.splice(next.rows.length)) root.remove(extra);
        next.rows.forEach((spec, index) => {
          let text = rows[index];
          if (text === undefined) {
            text = new TextRenderable(renderer, {
              id: `${root.id}-row-${String(index)}`, content: '', width: '100%', height: 1,
              flexShrink: 0, wrapMode: 'none',
            });
            rows[index] = text;
            root.add(text);
          }
          text.content = styledOf(spec, context.theme);
          text.fg = resolveToken(context.theme, spec.token);
          text.attributes = spec.bold ? BOLD : TextAttributes.NONE;
          text.onMouseDown = spec.hit === undefined ? undefined : () => { context.onHit(spec.hit as string); };
        });
      };
      update(node);
      binding = { renderable: root, node, update(next) { if (next.kind === 'text') update(next); } };
      break;
    }
    case 'stack':
    case 'block': {
      let marker: BoxRenderable | undefined;
      let content = root;
      if (node.kind === 'block') {
        root.flexDirection = 'row';
        marker = new BoxRenderable(renderer, { id: `${root.id}-accent`, width: 1, height: '100%' });
        root.add(marker);
        content = new BoxRenderable(renderer, {
          id: `${root.id}-content`, flexGrow: 1, height: '100%', flexDirection: 'column', paddingLeft: 1,
        });
        root.add(content);
      }
      const nested = createChildGroup(context, content);
      const update = (next: typeof node): void => {
        root.height = heightOf(next);
        if (marker !== undefined && next.kind === 'block') marker.backgroundColor = resolveToken(context.theme, next.tone);
        nested.update(next.children, (child, index) => ({
          marginTop: next.kind === 'stack' && index > 0 ? next.gap : 0,
        }));
        hit(next.kind === 'block' ? next.hit : undefined);
      };
      update(node);
      binding = { renderable: root, node, update(next) { if (next.kind === 'stack' || next.kind === 'block') update(next); } };
      break;
    }
    case 'panel': {
      root.border = true;
      root.borderStyle = 'rounded';
      root.titleAlignment = 'left';
      root.paddingLeft = 1;
      root.paddingRight = 1;
      root.overflow = 'hidden';
      const header = new TextRenderable(renderer, {
        id: `${root.id}-header`, content: '', height: 1, width: '100%', wrapMode: 'none',
        attributes: BOLD,
      });
      const body = new BoxRenderable(renderer, { id: `${root.id}-body`, flexDirection: 'column', flexGrow: 1, overflow: 'hidden' });
      const actions = new BoxRenderable(renderer, { id: `${root.id}-actions`, flexDirection: 'column', flexShrink: 0 });
      root.add(header);
      root.add(body);
      root.add(actions);
      const nested = createChildGroup(context, body);
      const actionGroup = createChildGroup(context, actions);
      let current = node;
      const layoutChildren = (height: number): void => {
        actions.height = (current.actions ?? []).reduce((sum, child) => sum + heightOf(child), 0);
        const fixed = current.children.filter((child) => child.kind !== 'scrolltext').reduce((sum, child) => sum + heightOf(child), 0);
        nested.update(current.children, (child) => ({
          height: child.kind === 'scrolltext' ? Math.max(1, height - actions.height - 2 - fixed) : heightOf(child),
        }));
      };
      const update = (next: typeof node): void => {
        current = next;
        root.height = heightOf(next);
        const rail = next.rail === true;
        root.borderColor = resolveToken(context.theme, next.tone);
        root.border = !rail;
        root.title = rail ? undefined : ` ${next.title} `;
        header.content = rail ? ` ${next.title}` : '';
        header.height = rail ? 1 : 0;
        header.bg = rail ? resolveToken(context.theme, 'brand') : undefined;
        header.fg = rail ? RGBA.fromHex('#141419') : resolveToken(context.theme, next.tone);
        layoutChildren(root.height);
        actionGroup.update(next.actions ?? []);
        hit(next.hit);
      };
      update(node);
      binding = { renderable: root, node, resize: layoutChildren, update(next) { if (next.kind === 'panel') update(next); } };
      break;
    }
    case 'choice': {
      root.height = 1;
      const text = new TextRenderable(renderer, {
        id: `${root.id}-label`, width: '100%', height: 1, wrapMode: 'none',
      });
      root.add(text);
      const update = (next: typeof node): void => {
        root.backgroundColor = next.selected ? resolveToken(context.theme, 'act') : undefined;
        text.content = ` ${next.text}`;
        text.fg = next.selected ? RGBA.fromHex('#141419') : resolveToken(context.theme, next.token);
        text.attributes = next.selected ? BOLD : TextAttributes.NONE;
        hit(next.hit);
      };
      update(node);
      binding = { renderable: root, node, update(next) { if (next.kind === 'choice') update(next); } };
      break;
    }
    case 'status': {
      root.height = 1;
      root.flexDirection = 'row';
      const activity = new TextRenderable(renderer, {
        id: `${root.id}-activity`, height: 1, flexGrow: 1, wrapMode: 'none',
      });
      root.add(activity);
      const facts: TextRenderable[] = [];
      const update = (next: StatusNode): void => {
        activity.content = next.activity;
        activity.fg = resolveToken(context.theme, next.token);
        activity.attributes = BOLD;
        for (const extra of facts.splice(next.facts.length)) root.remove(extra);
        next.facts.forEach((fact, index) => {
          let item = facts[index];
          if (item === undefined) {
            item = new TextRenderable(renderer, {
              id: `${root.id}-fact-${String(index)}`, content: '', height: 1, wrapMode: 'none', marginLeft: 1,
            });
            facts[index] = item;
            root.add(item);
          }
          item.content = ` ${fact.label} ${fact.value} `;
          item.fg = resolveToken(context.theme, 'textDim');
        });
      };
      update(node);
      binding = { renderable: root, node, update(next) { if (next.kind === 'status') update(next); } };
      break;
    }
    case 'sprite': {
      root.flexDirection = 'column';
      const rows: BoxRenderable[] = [];
      const cells: TextRenderable[][] = [];
      const update = (next: SpriteNode): void => {
        root.height = heightOf(next);
        root.width = Math.ceil((next.pixels[0]?.length ?? 0) / 2);
        const colorOfPixel = (pixel: SpriteNode['pixels'][number][number]) => pixel === null
          ? undefined
          : resolveToken(context.theme, `cat${pixel[0]?.toUpperCase() ?? ''}${pixel.slice(1)}` as TokenName);
        for (let y = 0; y < Math.ceil(next.pixels.length / 2); y += 1) {
          let row = rows[y];
          if (row === undefined) {
            row = new BoxRenderable(renderer, { id: `${root.id}-y-${String(y)}`, height: 1, flexDirection: 'row' });
            rows[y] = row;
            cells[y] = [];
            root.add(row);
          }
          for (let x = 0; x < Math.ceil((next.pixels[0]?.length ?? 0) / 2); x += 1) {
            let cell = cells[y]?.[x];
            if (cell === undefined) {
              cell = new TextRenderable(renderer, {
                id: `${root.id}-x-${String(y)}-${String(x)}`, content: ' ', width: 1, height: 1, wrapMode: 'none',
              });
              (cells[y] as TextRenderable[])[x] = cell;
              row.add(cell);
            }
            const raster = quadrantCell(next.pixels, x, y);
            cell.content = raster.glyph;
            cell.fg = colorOfPixel(raster.foreground);
            cell.bg = colorOfPixel(raster.background);
          }
        }
      };
      update(node);
      binding = { renderable: root, node, update(next) { if (next.kind === 'sprite') update(next); } };
      break;
    }
    case 'image': {
      root.height = node.image.rows;
      root.width = node.image.cols;
      const image = new ImageRenderable(renderer, {
        id: `${root.id}-image`, source: node.image.source, protocol: 'auto', fit: 'fit',
        width: node.image.cols, height: node.image.rows,
        onLoad: () => { renderer.requestRender(); }, onError: () => { renderer.requestRender(); },
      });
      root.add(image);
      binding = { renderable: root, node, update(next) {
        if (next.kind !== 'image') return;
        root.height = next.image.rows;
        root.width = next.image.cols;
        image.source = next.image.source;
        image.width = next.image.cols;
        image.height = next.image.rows;
      } };
      break;
    }
  }
  return binding;
}

interface MountedChild {
  readonly binding: SceneBinding;
  node: SceneNode;
}

export interface SceneGroup {
  update(nodes: readonly SceneNode[], layout?: (node: SceneNode, index: number) => {
    readonly top?: number;
    readonly marginTop?: number;
    readonly height?: number;
    readonly flexGrow?: number;
    readonly flexShrink?: number;
    readonly minHeight?: number;
  }): void;
  readonly bindings: readonly SceneBinding[];
}

export function createChildGroup(context: SceneContext, parent: BoxRenderable): SceneGroup {
  const mounted: MountedChild[] = [];
  return {
    get bindings() { return mounted.map((child) => child.binding); },
    update(nodes, layout) {
      nodes.forEach((node, index) => {
        const previous = mounted[index];
        const replaced = previous === undefined || previous.node.kind !== node.kind || previous.node.key !== node.key;
        let child = previous;
        if (replaced) {
          if (previous !== undefined) parent.remove(previous.binding.renderable);
          child = { binding: mountScene(context, parent, node, index), node };
          mounted[index] = child;
        } else if (previous.node !== node) {
          previous.binding.update(node);
          previous.node = node;
        }
        if (child === undefined) return;
        const place = layout?.(node, index);
        child.binding.renderable.top = place?.top ?? 0;
        child.binding.renderable.marginTop = place?.marginTop ?? 0;
        child.binding.renderable.height = place?.height ?? heightOf(node);
        child.binding.renderable.flexGrow = place?.flexGrow ?? 0;
        child.binding.renderable.flexShrink = place?.flexShrink ?? 0;
        child.binding.renderable.minHeight = place?.minHeight ?? 0;
        child.binding.resize?.(child.binding.renderable.height);
      });
      for (const extra of mounted.splice(nodes.length)) parent.remove(extra.binding.renderable);
    },
  };
}

export function removeSceneTree(parent: BoxRenderable, binding: SceneBinding): void {
  parent.remove(binding.renderable);
}
