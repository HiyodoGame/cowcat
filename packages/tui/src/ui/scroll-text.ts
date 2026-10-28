import { BoxRenderable, RGBA, StyledText, TextRenderable, type MouseEvent, type TextChunk } from '@opentui/core';
import type { Line } from './line.js';
import type { ScrollTextNode } from './scene.js';
import { resolveToken, type SceneBinding, type SceneContext } from './primitives.js';

class ScrollTextRenderable extends TextRenderable {
  followTail = true;

  protected override onMouseEvent(event: MouseEvent): void {
    if (event.type === 'scroll' && event.scroll !== undefined) {
      const step = Math.max(1, Math.abs(event.scroll.delta));
      this.followTail = false;
      this.scrollY += event.scroll.direction === 'up' ? -step : step;
      return;
    }
    super.onMouseEvent(event);
  }
}

export function mountScrollText(context: SceneContext, parent: BoxRenderable, node: ScrollTextNode, index?: number): SceneBinding {
  const root = new BoxRenderable(context.renderer, {
    id: `scene-scrolltext-${node.key}`, width: '100%', height: node.rows.length, flexShrink: 0,
  });
  parent.add(root, index);
  const text = new ScrollTextRenderable(context.renderer, {
    id: `${root.id}-content`, content: styledRows(node.rows, context), width: '100%', height: '100%',
    wrapMode: 'none', fg: resolveToken(context.theme, node.rows[0]?.token ?? 'text'),
  });
  root.add(text);
  let current = node;
  text.onLifecyclePass = () => {
    if (text.followTail) text.scrollY = Math.max(0, text.virtualLineCount - root.height);
  };
  return {
    renderable: root,
    node,
    resize(height) { root.height = height; },
    update(next) {
      if (next.kind !== 'scrolltext') return;
      if (next.key !== current.key) text.followTail = true;
      current = next;
      text.content = styledRows(next.rows, context);
    },
  };
}

function styledRows(rows: readonly Line[], context: SceneContext): string | StyledText {
  if (rows.every((row) => row.runs === undefined || row.runs.length === 0)) return rows.map((row) => row.text).join('\n');
  const chunks: TextChunk[] = [];
  for (const [index, row] of rows.entries()) {
    for (const run of row.runs ?? [{ text: row.text, token: row.token, ...(row.bold ? { bold: true } : {}) }]) {
      const color = context.theme.foreground[run.token];
      chunks.push({
        __isChunk: true,
        text: run.text,
        ...(color === null ? {} : { fg: RGBA.fromHex(color) }),
        ...(run.bold === true ? { attributes: 1 } : {}),
      });
    }
    if (index < rows.length - 1) chunks.push({ __isChunk: true, text: '\n' });
  }
  return new StyledText(chunks);
}
