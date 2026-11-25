import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import type { DialogSpec } from '../app/dialog.js';
import { truncate } from '../text/width.js';
import { line } from './line.js';
import { choiceBlock, textBlock, type SceneNode } from './scene.js';
import { createChildGroup, resolveToken } from './primitives.js';
import { BRAND, type Theme } from '../theme/tokens.js';

export interface DialogView {
  update(spec: DialogSpec | undefined): void;
}

export function createDialog(renderer: CliRenderer, theme: Theme, parent: BoxRenderable, onHit: (id: string) => void): DialogView {
  const layer = new BoxRenderable(renderer, {
    id: 'cowcat-dialog-layer', position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
    zIndex: 50, flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', visible: false,
  });
  parent.add(layer);
  const window = new BoxRenderable(renderer, {
    id: 'cowcat-dialog', width: 70, border: true, borderStyle: 'rounded', borderColor: resolveToken(theme, 'border'),
    paddingLeft: 1, paddingRight: 1, flexDirection: 'column', overflow: 'hidden',
    // Key hints live on the bottom border, the same place the composer puts 'Enter 发送'.
    bottomTitleAlignment: 'right',
  });
  layer.add(window);
  // The input owns a bordered field, the same chrome as the composer, instead of a bare line.
  const searchBox = new BoxRenderable(renderer, {
    id: 'cowcat-dialog-search-box', width: '100%', height: 3, border: true, borderStyle: 'rounded',
    borderColor: resolveToken(theme, 'border'), paddingLeft: 1, paddingRight: 1, marginBottom: 1, flexShrink: 0,
  });
  window.add(searchBox);
  const search = new TextRenderable(renderer, {
    id: 'cowcat-dialog-search', content: '', height: 1, width: '100%', wrapMode: 'none',
  });
  searchBox.add(search);
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
        // Group labels stay quiet like the side-panel titles; brand is for the window title only.
        if (dialogGroup.title !== null) children.push(textBlock(`group-${String(groupIndex)}`, [line(dialogGroup.title, 'textDim', true)]));
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
      searchBox.visible = searching;
      const value = spec.input?.value ?? spec.query ?? '';
      // A dialog input owns its own caret: the terminal cursor sits in the composer, so draw one here.
      search.content = value === '' ? (spec.input?.placeholder ?? '输入以筛选') : spec.input === undefined ? value : `${value}▏`;
      search.fg = resolveToken(theme, value === '' ? 'textDim' : 'text');
      // Key first and separated by a middle dot, matching the dock panels ('↑↓ 选择 · x 停止 · Esc 关闭').
      window.bottomTitle = spec.footer.length === 0 ? undefined : ` ${spec.footer.map((entry) => `${keyName(entry.key)} ${entry.label}`).join(' · ')} `;
      error.visible = spec.error !== undefined;
      error.content = spec.error === undefined ? '' : truncate(spec.error, 60);
      const maxHeight = Math.max(6, Math.floor(renderer.height * 0.86));
      const fixed = 2 + (searching ? 4 : 0) + (spec.error === undefined ? 0 : 2);
      const listHeight = Math.max(1, Math.min(children.length, maxHeight - fixed));
      list.height = listHeight;
      list.content.height = children.length;
      if (selected >= 0) list.scrollTop = Math.max(0, selected - listHeight + 1);
      else list.scrollTop = Math.min(list.scrollTop, Math.max(0, children.length - listHeight));
      // Layering without a foreign look: the window follows the terminal's own theme and the
      // backdrop is dimmed rather than replaced, so the dialog reads as the front layer of THIS app.
      applySurface(renderer, layer, window);
      window.title = spec.title;
      window.titleColor = resolveToken(theme, 'brand');
      window.width = Math.max(20, Math.min(70, renderer.width - 4));
      window.height = Math.min(maxHeight, listHeight + fixed);
      layer.visible = true;
      renderer.requestRender();
    },
  };
}

/** The footer names keys the way panels do: `Enter`, `Esc`, `↑↓`, anything else unchanged. */
function keyName(key: string): string {
  if (key === 'enter') return 'Enter';
  if (key === 'esc') return 'Esc';
  if (key === 'tab') return 'Tab';
  return key;
}

/**
 * ADR-178: a dialog is a layer, not a second skin. Its surface follows the terminal theme —
 * light terminals get the brand paper, dark terminals a near-black card — and the backdrop is
 * the same darkness at low alpha so the session stays visible but recedes. An unresolved theme
 * (no OSC reply) leaves both transparent: guessing wrong would recreate the "other app" look.
 */
function applySurface(renderer: CliRenderer, layer: BoxRenderable, window: BoxRenderable): void {
  const mode = renderer.themeMode;
  if (mode === 'light') {
    layer.backgroundColor = RGBA.fromInts(20, 20, 25, 80);
    window.backgroundColor = RGBA.fromHex(BRAND.paper);
    return;
  }
  if (mode === 'dark') {
    layer.backgroundColor = RGBA.fromInts(0, 0, 0, 120);
    window.backgroundColor = RGBA.fromHex('#1B1B22');
    return;
  }
  layer.backgroundColor = RGBA.fromInts(0, 0, 0, 0);
  window.backgroundColor = RGBA.fromInts(0, 0, 0, 0);
}
