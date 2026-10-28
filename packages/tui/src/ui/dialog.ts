import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import type { DialogSpec } from '../app/dialog.js';
import { truncate } from '../text/width.js';
import { line } from './line.js';
import { choiceBlock, textBlock, type SceneNode } from './scene.js';
import { createChildGroup, resolveToken } from './primitives.js';
import type { Theme } from '../theme/tokens.js';

export interface DialogView {
  update(spec: DialogSpec | undefined): void;
}

export function createDialog(renderer: CliRenderer, theme: Theme, parent: BoxRenderable, onHit: (id: string) => void): DialogView {
  const layer = new BoxRenderable(renderer, {
    id: 'cowcat-dialog-layer', position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
    zIndex: 50, backgroundColor: RGBA.fromHex('#141419'), flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', visible: false,
  });
  parent.add(layer);
  const window = new BoxRenderable(renderer, {
    id: 'cowcat-dialog', width: 70, border: true, borderStyle: 'rounded', borderColor: resolveToken(theme, 'border'),
    backgroundColor: RGBA.fromHex('#2A2A33'), paddingLeft: 1, paddingRight: 1, flexDirection: 'column', overflow: 'hidden',
  });
  layer.add(window);
  const search = new TextRenderable(renderer, {
    id: 'cowcat-dialog-search', content: '', height: 1, width: '100%', wrapMode: 'none', marginBottom: 1,
  });
  window.add(search);
  const error = new TextRenderable(renderer, {
    id: 'cowcat-dialog-error', content: '', height: 1, width: '100%', wrapMode: 'none', marginBottom: 1,
    fg: resolveToken(theme, 'alert'), visible: false,
  });
  window.add(error);
  const list = new ScrollBoxRenderable(renderer, {
    id: 'cowcat-dialog-list', width: '100%', height: 1, flexShrink: 0, scrollY: true,
    contentOptions: { flexDirection: 'column' },
  });
  window.add(list);
  const footer = new TextRenderable(renderer, {
    id: 'cowcat-dialog-footer', content: '', height: 1, width: '100%', wrapMode: 'none', marginTop: 1,
    fg: resolveToken(theme, 'textDim'),
  });
  window.add(footer);
  const group = createChildGroup({ renderer, theme, onHit }, list.content);

  return {
    update(spec) {
      if (spec === undefined) {
        layer.visible = false;
        return;
      }
      const children: SceneNode[] = [];
      let selected = -1;
      for (const [groupIndex, dialogGroup] of spec.groups.entries()) {
        if (dialogGroup.title !== null) children.push(textBlock(`group-${String(groupIndex)}`, [line(dialogGroup.title, 'brand', true)]));
        for (const [rowIndex, row] of dialogGroup.rows.entries()) {
          if (row.selected === true) selected = children.length;
          const detail = row.detail === undefined ? '' : `  ${truncate(row.detail, 30)}`;
          const status = row.mark === undefined ? '' : ' 当前';
          children.push(choiceBlock(`row-${String(groupIndex)}-${String(rowIndex)}`, `${row.label}${status}${detail}`, {
            selected: row.selected ?? false, token: row.selected === true ? 'text' : 'textDim',
          }));
        }
      }
      group.update(children);
      const searching = spec.query !== undefined || spec.input !== undefined;
      search.visible = searching;
      const value = spec.input?.value ?? spec.query ?? '';
      search.content = value === '' ? (spec.input?.placeholder ?? '输入以筛选') : value;
      search.fg = resolveToken(theme, value === '' ? 'textDim' : 'text');
      footer.content = spec.footer.map((entry) => `${entry.label} ${entry.key}`).join('   ');
      error.visible = spec.error !== undefined;
      error.content = spec.error === undefined ? '' : truncate(spec.error, 60);
      const maxHeight = Math.max(6, Math.floor(renderer.height * 0.86));
      const fixed = 4 + (searching ? 2 : 0) + (spec.error === undefined ? 0 : 2);
      const listHeight = Math.max(1, Math.min(children.length, maxHeight - fixed));
      list.height = listHeight;
      list.content.height = children.length;
      if (selected >= 0) list.scrollTop = Math.max(0, selected - listHeight + 1);
      else list.scrollTop = Math.min(list.scrollTop, Math.max(0, children.length - listHeight));
      window.title = spec.title;
      window.titleColor = resolveToken(theme, 'text');
      window.width = Math.max(20, Math.min(70, renderer.width - 4));
      window.height = Math.min(maxHeight, listHeight + fixed);
      layer.visible = true;
      renderer.requestRender();
    },
  };
}
