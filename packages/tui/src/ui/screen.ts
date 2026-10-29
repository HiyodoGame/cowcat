import { BoxRenderable, TextRenderable, createTextAttributes, type CliRenderer, type KeyEvent } from '@opentui/core';
import type { Theme } from '../theme/tokens.js';
import type { DialogSpec } from '../app/dialog.js';
import { line } from './line.js';
import { heightOf, panelBlock, stackBlock, textBlock, type SceneNode, type StatusNode } from './scene.js';
import { createChildGroup, resolveToken, type SceneContext } from './primitives.js';
import { createDialog } from './dialog.js';
import { createComposer } from './composer.js';
import { wrap } from '../text/wrap.js';

const READING_WIDTH = 100;
const LEFT_RAIL_WIDTH = 43;
const ASIDE_WIDTH = 28;

export interface ImageSlot {
  readonly row: number;
  readonly left: number;
  readonly cols: number;
  readonly rows: number;
  readonly source: Uint8Array;
  readonly label: string;
}

export interface ScreenSpec {
  readonly body: readonly SceneNode[];
  readonly dock?: readonly SceneNode[];
  readonly dialog?: DialogSpec;
  readonly leftRail?: import('../app/rails.js').LeftRailSpec;
  readonly aside?: import('../app/rails.js').AsideSpec;
  readonly status: StatusNode;
  readonly placeholder: string;
  readonly scroll?: number;
}

export interface Screen {
  update(spec: ScreenSpec): void;
  contentWidth(): number;
  contentHeight(): number;
  onSubmit(handler: (value: string) => void): () => void;
  onKey(handler: (key: KeyEvent) => void): () => void;
  onHit(handler: (id: string) => void): () => void;
  onScroll(handler: (delta: number) => void): () => void;
  clearInput(): void;
  setInput(text: string): void;
  inputValue(): string;
  cursorRow(): number;
  inputLineCount(): number;
  syncInputSize(): void;
  dialog(spec: DialogSpec | undefined): void;
  wideRails(): boolean;
  activityRail(): boolean;
  focus(): void;
  destroy(): void;
}

export function createScreen(renderer: CliRenderer, theme: Theme, options: { readonly title: string }): Screen {
  const root = new BoxRenderable(renderer, {
    id: 'cowcat-root', width: '100%', height: '100%', flexDirection: 'column',
  });
  renderer.root.add(root);
  const header = new TextRenderable(renderer, {
    id: 'cowcat-brand', content: ` ${options.title}`, fg: resolveToken(theme, 'brand'),
    attributes: createTextAttributes({ bold: true }), height: 1, width: '100%', wrapMode: 'none',
  });
  root.add(header);

  const page = new BoxRenderable(renderer, { id: 'cowcat-page', width: '100%', flexGrow: 1, flexDirection: 'row' });
  const center = new BoxRenderable(renderer, { id: 'cowcat-center', flexGrow: 1, flexDirection: 'row', justifyContent: 'center' });
  const main = new BoxRenderable(renderer, {
    id: 'cowcat-main', width: '100%', maxWidth: READING_WIDTH + 2, flexDirection: 'column', paddingLeft: 1, paddingRight: 1,
  });
  center.add(main);
  page.add(center);
  root.add(page);

  const leftRail = new BoxRenderable(renderer, {
    id: 'cowcat-activity', width: LEFT_RAIL_WIDTH, flexShrink: 0, flexDirection: 'column', marginRight: 2,
  });
  const aside = new BoxRenderable(renderer, {
    id: 'cowcat-aside', width: ASIDE_WIDTH, flexShrink: 0, flexDirection: 'column', marginLeft: 2,
  });
  const body = new BoxRenderable(renderer, { id: 'cowcat-body', flexGrow: 1, width: '100%', flexDirection: 'column', overflow: 'hidden' });
  const dock = new BoxRenderable(renderer, {
    id: 'cowcat-dock', width: '100%', flexDirection: 'column', flexShrink: 0, marginBottom: 1, overflow: 'hidden',
  });
  const status = new BoxRenderable(renderer, { id: 'cowcat-status', width: '100%', height: 1, flexShrink: 0, marginBottom: 1 });
  main.add(body);
  main.add(dock);
  main.add(status);

  let hitHandler: (id: string) => void = () => undefined;
  let scrollHandler: (delta: number) => void = () => undefined;
  const context: SceneContext = { renderer, theme, onHit: (id) => { hitHandler(id); } };
  const bodyGroup = createChildGroup(context, body);
  const dockGroup = createChildGroup(context, dock);
  const statusGroup = createChildGroup(context, status);
  const leftGroup = createChildGroup(context, leftRail);
  const asideGroup = createChildGroup(context, aside);
  const composer = createComposer(renderer, theme, main);
  const dialog = createDialog(renderer, theme, root, (id) => { hitHandler(id); });

  body.onMouseScroll = (event) => {
    const scroll = event.scroll;
    if (scroll === undefined) return;
    const step = Math.max(1, Math.abs(scroll.delta));
    scrollHandler(scroll.direction === 'up' ? step : -step);
  };

  const activityRail = (): boolean => renderer.width >= 160 && renderer.height >= 32 && process.env.COWCAT_SIDEBAR !== 'off';
  const asideVisible = (): boolean => renderer.width >= 104 && process.env.COWCAT_SIDEBAR !== 'off';
  let leftMounted = false;
  let asideMounted = false;

  function clipLines(rows: readonly ReturnType<typeof line>[], capacity: number): readonly ReturnType<typeof line>[] {
    if (rows.length <= capacity) return rows;
    const shown = Math.max(0, capacity - 1);
    return [...rows.slice(0, shown), line(`另有 ${String(rows.length - shown)} 项`, 'textDim')];
  }

  function railPanels(spec: import('../app/rails.js').LeftRailSpec | undefined, activityHeight: number): readonly SceneNode[] {
    if (spec === undefined) return [];
    return [
      ...spec.panels.map((panel, index) => panelBlock({
        key: `activity-${panel.title}-${String(index)}`, title: panel.title, tone: 'brand', rail: true,
        children: [textBlock('rows', clipLines(panel.rows.flatMap((row) => wrap(row.text, LEFT_RAIL_WIDTH - 2).map((text) => line(text, row.accent === true ? 'act' : row.dim === true ? 'textDim' : 'text'))), activityHeight - 1))],
      })),
      spec.mascot,
    ];
  }

  function infoPanels(spec: import('../app/rails.js').AsideSpec | undefined): readonly SceneNode[] {
    return (spec?.panels ?? []).map((panel, index) => panelBlock({
      key: `info-${panel.title}-${String(index)}`, title: panel.title, tone: 'brand', rail: true,
      children: panel.rows.map((row, rowIndex) => stackBlock(`fact-${String(rowIndex)}`, [
        textBlock('label', [line(row.label, 'textDim')]),
        textBlock('value', wrap(row.value, ASIDE_WIDTH - 2).map((text) => line(text, row.valueAccent === true ? 'act' : 'text'))),
      ])),
    }));
  }

  return {
    contentWidth() {
      const rails = (activityRail() ? LEFT_RAIL_WIDTH + 2 : 0) + (asideVisible() ? ASIDE_WIDTH + 2 : 0);
      const width = Math.max(8, renderer.width - rails - 2);
      return process.env.COWCAT_WIDTH === 'full' ? width : Math.min(READING_WIDTH, width);
    },
    contentHeight() { return renderer.height; },
    dialog(spec) { dialog.update(spec); },
    wideRails() { return asideVisible(); },
    activityRail,
    update(spec) {
      main.maxWidth = process.env.COWCAT_WIDTH === 'full' ? 100_000 : READING_WIDTH + 2;
      const bodyBudget = Math.max(1, renderer.height - 3 - composer.height());
      const contentHeight = (spec.dock ?? []).reduce((sum, node) => sum + heightOf(node) + 1, 0);
      const dockHeight = Math.min(contentHeight, Math.max(0, bodyBudget - 2));
      dock.height = dockHeight;
      dockGroup.update(spec.dock ?? [], (node, index) => ({
        marginTop: 1,
        ...(index === 0 && node.kind === 'panel' && (node.actions?.length ?? 0) > 0
          ? { height: Math.min(heightOf(node), dockHeight) }
          : {}),
      }));
      const room = Math.max(1, bodyBudget - dockHeight);
      const offsets: number[] = [];
      let total = 0;
      for (const node of spec.body) {
        offsets.push(total);
        total += heightOf(node) + 1;
      }
      const maxScroll = Math.max(0, total - room);
      const scroll = Math.max(0, Math.min(maxScroll, spec.scroll ?? 0));
      const start = Math.max(0, total - room - scroll);
      const visible = spec.body.filter((node, index) => {
        const top = offsets[index] ?? 0;
        return top + heightOf(node) > start && top < start + room;
      });
      bodyGroup.update(visible, (node) => {
        const index = spec.body.indexOf(node);
        return { top: (offsets[index] ?? 0) - start };
      });
      for (const binding of bodyGroup.bindings) binding.renderable.position = 'absolute';
      statusGroup.update([spec.status]);

      const wantLeft = activityRail() && spec.leftRail !== undefined;
      const wantAside = asideVisible() && spec.aside !== undefined;
      if (wantLeft !== leftMounted) {
        if (wantLeft) page.add(leftRail, 0);
        else page.remove(leftRail);
        leftMounted = wantLeft;
      }
      if (wantAside !== asideMounted) {
        if (wantAside) page.add(aside);
        else page.remove(aside);
        asideMounted = wantAside;
      }
      if (wantLeft) {
        const mascotHeight = spec.leftRail === undefined ? 0 : heightOf(spec.leftRail.mascot);
        const activityHeight = Math.max(2, Math.floor((renderer.height - mascotHeight - 3) / 3));
        leftGroup.update(railPanels(spec.leftRail, activityHeight), (node, index) => ({
          marginTop: index === 0 ? 0 : 1,
          height: index < 3 ? activityHeight : heightOf(node),
          flexShrink: 0,
        }));
      }
      if (wantAside) {
        const nodes = infoPanels(spec.aside);
        asideGroup.update(nodes, (_node, index) => ({ marginTop: index === 0 ? 0 : 1, flexGrow: index === nodes.length - 1 ? 1 : 0 }));
      }
      dialog.update(spec.dialog);
      composer.setPlaceholder(spec.placeholder);
      renderer.requestRender();
    },
    onSubmit(handler) {
      composer.input.onSubmit = () => { handler(composer.input.plainText); };
      return () => { composer.input.onSubmit = undefined; };
    },
    onKey(handler) {
      const listener = (key: KeyEvent): void => { handler(key); };
      renderer.keyInput.on('keypress', listener);
      return () => renderer.keyInput.off('keypress', listener);
    },
    onHit(handler) {
      hitHandler = handler;
      return () => { hitHandler = () => undefined; };
    },
    onScroll(handler) {
      scrollHandler = handler;
      return () => { scrollHandler = () => undefined; };
    },
    clearInput() { composer.clear(); },
    setInput(text) { composer.set(text); },
    inputValue() { return composer.input.plainText; },
    cursorRow() { return composer.input.visualCursor.visualRow; },
    inputLineCount() { return Math.max(1, composer.input.virtualLineCount); },
    syncInputSize() { composer.syncSize(); },
    focus() { composer.input.focus(); },
    destroy() { renderer.root.remove(root); },
  };
}
