import {
  BoxRenderable,
  ImageRenderable,
  RGBA,
  StyledText,
  TextareaRenderable,
  TextAttributes,
  TextRenderable,
  createTextAttributes,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from '@opentui/core';
import { colorOf, type Theme, type TokenName } from '../theme/tokens.js';
import type { Line } from './line.js';
import type { DialogSpec } from '../app/dialog.js';

/**
 * The one file that knows about opentui (ADR-066 ③).
 *
 * Everything above it produces `Line`s and a status; everything below it is a renderable.
 * The components are therefore testable with no terminal installed, and a renderer change
 * (opentui's API is 0.6.6 and its own types describe setters that do not exist) is a change
 * to this file rather than to every component.
 *
 * Three facts here were established by running the machine, not by reading its types
 * (`tools/tui-api-probe.mjs`):
 *
 *   * `content`, `fg`, `attributes` and `placeholder` DO have setters, so a line can be
 *     updated in place — which is what makes per-token streaming cheap instead of a full
 *     rebuild of the transcript;
 *   * `BoxRenderable.remove(id)` exists, so shrinking the transcript is not a leak;
 *   * `'default'` is not a colour name to this library (it would warn and paint magenta),
 *     so the terminal's own foreground comes from `RGBA.defaultForeground()`.
 */

/**
 * Rows the screen spends on something other than the transcript: the root box's two borders,
 * the status line, and the composer's three rows.
 */
/**
 * The reading width, in columns (ADR-101).
 *
 * A 200-column terminal made every card 198 columns wide with one line of content and a
 * border at the far right — the screenshot that prompted this. Claude Code and Codex both
 * keep a readable column; 100 is the width this interface was designed and snapshot-tested
 * against.
 */
const READING_WIDTH = 100;

/** Columns the session aside occupies, rail content plus its gutter (ADR-163). */
const ASIDE_WIDTH = 26;

/**
 * An image, as a rectangle of the frame rather than a line of it.
 *
 * Images are a separate channel on purpose: a `Line` is text with a theme token, and a pixel
 * is neither. The frame builder reserves the rows and says where the image goes; the screen
 * mounts a renderable over them. That keeps the text model pure — and it means an image that
 * never loads leaves a properly-sized hole rather than a broken layout.
 */
export interface ImageSlot {
  /** Row offset inside `body`. The `rows` below it belong to the image. */
  readonly row: number;
  /** Column offset inside `body`: a card's image starts after its `│ ` frame. */
  readonly left: number;
  readonly cols: number;
  readonly rows: number;
  readonly source: Uint8Array;
  /** `image/png 320x200`, for the diagnostics and for a failing renderer's message. */
  readonly label: string;
}

export interface ScreenSpec {
  readonly body: readonly Line[];
  /** Fixed panels above the status line: approval, running agents, todos (ADR-101). */
  readonly dock?: readonly Line[];
  /** The modal dialog (ADR-166): mounted as a centred floating window above everything. */
  readonly dialog?: import('../app/dialog.js').DialogSpec;
  /** The left rail (ADR-168): structured panels + mascot, mounted as components. */
  readonly leftRail?: import('../app/rails.js').LeftRailSpec;
  /** The right rail (ADR-168): titled info panels, mounted as components. */
  readonly aside?: import('../app/rails.js').AsideSpec;
  readonly status: Line;
  readonly placeholder: string;
  readonly images?: readonly ImageSlot[];
  /** Lines scrolled up from the newest row; 0 follows the tail. */
  readonly scroll?: number;
}

export interface Screen {
  update(spec: ScreenSpec): void;
  /**
   * The columns a component may use: the terminal's, minus this screen's own chrome.
   *
   * The frame builder is handed this rather than the terminal width because the card borders
   * and the root border both have to fit — measuring against the terminal is how a card ends
   * up two cells too wide and wraps itself out of its own box (measured: they did).
   */
  contentWidth(): number;
  /** The terminal's rows; the frame uses it to cap the dock. */
  contentHeight(): number;
  /** Called with the input's value when the user presses Enter. */
  onSubmit(handler: (value: string) => void): () => void;
  /** Every keypress, including the ones the input swallowed. */
  onKey(handler: (key: KeyEvent) => void): () => void;
  /** A click on a row that carried a `hit` id. */
  onHit(handler: (id: string) => void): () => void;
  /** Wheel movement: positive is up (older content). */
  onScroll(handler: (delta: number) => void): () => void;
  clearInput(): void;
  /** Replace the input's text (used by Tab-completion of a `/` command). */
  setInput(text: string): void;
  /** The input's text right now — used to hint at `/` commands while typing. */
  inputValue(): string;
  /** The composer's cursor row in **visual** rows, 0-based (ADR-106): wrapped text counts. */
  cursorRow(): number;
  /** How many visual rows the composer's text occupies, wrapping included (ADR-106). */
  inputLineCount(): number;
  /** Grow or shrink the composer to fit the draft (1–6 content rows). */
  syncInputSize(): void;
  /** Mount or update the modal dialog; undefined hides it (ADR-166). */
  dialog(spec: DialogSpec | undefined): void;
  /** Whether the three-column rails are mounted (terminal ≥120 and not switched off). */
  wideRails(): boolean;
  focus(): void;
  destroy(): void;
}

/** Cell-width-aware cut for dialog detail text (the width table, one-off form). */
function truncatePlain(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
}

/** A rail panel instance (ADR-168): its box plus a row setter the screen feeds each frame. */
interface Panel {
  readonly box: BoxRenderable;
  setRows(rows: readonly { readonly text: string; readonly dim?: boolean; readonly accent?: boolean }[]): void;
}

export function createScreen(renderer: CliRenderer, theme: Theme, options: { readonly title: string }): Screen {
  const root = new BoxRenderable(renderer, {
    id: 'cowcat-root',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    border: true,
    borderStyle: 'rounded',
    borderColor: resolve(theme, 'border'),
    title: options.title,
    titleAlignment: 'left',
  });
  renderer.root.add(root);

  // ── the modal dialog (ADR-166) ────────────────────────────────────────────────
  // Real components, mounted ONCE and updated in place: a centred floating window
  // (absolute, above everything) with a title bar, a search field, grouped rows whose
  // selection is a full-width BACKGROUND (not a glyph), and a shortcut footer. What
  // OpenCode/DevEco do; what character lines in a dock could never be.
  const dialogLayer = new BoxRenderable(renderer, {
    id: 'cowcat-dialog-layer',
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    zIndex: 50,
    backgroundColor: RGBA.fromHex('#00000066'),
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    visible: false,
  });
  const dialogWindow = new BoxRenderable(renderer, {
    id: 'cowcat-dialog',
    width: 70,
    maxHeight: '86%',
    backgroundColor: RGBA.fromHex('#1B1B22'),
    border: true,
    borderStyle: 'rounded',
    borderColor: resolve(theme, 'border'),
    title: '',
    titleAlignment: 'left',
    bottomTitle: 'esc 关闭',
    bottomTitleAlignment: 'right',
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: 'column',
    overflow: 'hidden',
  });
  const dialogSearch = new BoxRenderable(renderer, {
    id: 'cowcat-dialog-search',
    width: '100%',
    height: 1,
    backgroundColor: RGBA.fromHex('#2A2A33'),
    marginBottom: 1,
    visible: false,
  });
  const dialogSearchText = new TextRenderable(renderer, {
    id: 'cowcat-dialog-search-text',
    content: '',
    fg: resolve(theme, 'text'),
    wrapMode: 'none',
    width: '100%',
    height: 1,
  });
  dialogSearch.add(dialogSearchText);
  const dialogRows = new BoxRenderable(renderer, {
    id: 'cowcat-dialog-rows',
    width: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
  });
  const dialogFooter = new TextRenderable(renderer, {
    id: 'cowcat-dialog-footer',
    content: '',
    fg: resolve(theme, 'textDim'),
    wrapMode: 'none',
    width: '100%',
    height: 1,
    marginTop: 1,
  });
  dialogWindow.add(dialogSearch);
  dialogWindow.add(dialogRows);
  dialogWindow.add(dialogFooter);
  dialogLayer.add(dialogWindow);
  root.add(dialogLayer);
  // One row renderable per visible dialog row, reused across frames.
  const dialogRowRenderables: TextRenderable[] = [];

  /** Rebuild the row stack for the current spec: group titles, then rows — the selected
   * one painted full-width (Text's own bg; no wrapper boxes, no id collisions). */
  function renderDialogRows(spec: DialogSpec): void {
    for (const row of dialogRowRenderables) dialogRows.remove(row);
    dialogRowRenderables.length = 0;
    let sequence = 0;
    const next = (): string => {
      sequence += 1;
      return `dialog-${String(sequence)}`;
    };
    for (const group of spec.groups) {
      if (group.title !== null) {
        dialogRows.add(new TextRenderable(renderer, {
          id: next(),
          content: group.title,
          fg: resolve(theme, 'brand'),
          wrapMode: 'none',
          width: '100%',
          height: 1,
        }));
      }
      for (const row of group.rows) {
        dialogRowRenderables.push(new TextRenderable(renderer, {
          id: next(),
          content: `${row.mark === undefined ? '' : `${row.mark} `}${row.label}${row.detail === undefined ? '' : `  ${truncatePlain(row.detail, 30)}`}`,
          fg: row.selected ? RGBA.fromHex('#141419') : resolve(theme, 'text'),
          ...(row.selected ? { bg: RGBA.fromHex('#E0A63C') } : {}),
          attributes: row.selected ? createTextAttributes({ bold: true }) : TextAttributes.NONE,
          wrapMode: 'none',
          width: '100%',
          height: 1,
        }));
      }
    }
    for (const row of dialogRowRenderables) dialogRows.add(row);
  }

  function updateDialog(spec: DialogSpec): void {
    const becameVisible = !dialogLayer.visible;
    dialogLayer.visible = true;
    dialogWindow.title = spec.title;
    dialogSearch.visible = spec.query !== undefined;
    if (spec.query !== undefined) {
      dialogSearchText.content = `▏${spec.query}`;
    }
    if (spec.input !== undefined) {
      // The input dialog: the search field renders the typed value and the placeholder.
      dialogSearch.visible = true;
      dialogSearchText.content = spec.input.value === '' ? `▏${spec.input.placeholder}` : `▏${spec.input.value}`;
    }
    renderDialogRows(spec);
    dialogFooter.content = spec.footer.map((entry) => `${entry.label} ${entry.key}`).join('   ');
    if (becameVisible) renderer.requestRender();
  }

  function hideDialog(): void {
    dialogLayer.visible = false;
  }

  // The page is a ROW: a main column (everything the beta shipped) and — on wide
  // terminals — the session aside (ADR-163). On a narrow terminal the aside is never
  // added, so the layout is byte-for-byte the pre-sidebar one.
  const page = new BoxRenderable(renderer, {
    id: 'cowcat-page',
    width: '100%',
    maxWidth: READING_WIDTH,
    alignSelf: 'center',
    flexGrow: 1,
    flexDirection: 'row',
  });
  const main = new BoxRenderable(renderer, {
    id: 'cowcat-main',
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
  });
  const body = new BoxRenderable(renderer, {
    id: 'cowcat-body',
    flexGrow: 1,
    width: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
  });
  // The dock: approvals, running agents and todos live here, above the status line, and
  // never scroll with the transcript (ADR-101).
  const dock = new BoxRenderable(renderer, {
    id: 'cowcat-dock',
    width: '100%',
    flexDirection: 'column',
    flexShrink: 0,
  });
  const status = new TextRenderable(renderer, {
    id: 'cowcat-status',
    content: '',
    fg: resolve(theme, 'textDim'),
    attributes: createTextAttributes({ dim: true }),
    // Both of these matter: without them the column layout does not reserve a row for the
    // status line, and it gets drawn on top of the input (measured — the two rows' text
    // interleaved character by character in the frame snapshot).
    width: '100%',
    height: 1,
  });
  /**
   * The composer is a textarea, not a single-line input: Enter sends, Shift+Enter and
   * Ctrl+J insert a newline, and the box grows with the draft up to six rows (ADR-104).
   */
  const input = new TextareaRenderable(renderer, {
    id: 'cowcat-input',
    flexGrow: 1,
    placeholder: options.title,
    keyBindings: [
      // opentui names the key `return`; the default is `return → newline`, so `enter`
      // here would silently leave the composer unable to submit.
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      // Shift+Enter and Ctrl+Enter are only *distinguishable* from Enter when the terminal
      // speaks the kitty keyboard protocol (opentui asks for disambiguation at startup, and
      // plenty of terminals ignore the request). Without it both keys arrive as a bare CR and
      // the row above would submit. `Alt` survives that: legacy terminals encode it as ESC CR,
      // which still parses as `meta + return` — measured with a headless renderer, see
      // `test/composer.test.ts`.
      { name: 'return', meta: true, action: 'newline' },
      // Ctrl+J is a literal LF, so it needs no protocol support at all.
      { name: 'j', ctrl: true, action: 'newline' },
      // Spelling out opentui's own `linefeed → newline` default on purpose. Ctrl+Enter and
      // Ctrl+J both arrive as a single 0x0a on xterm-family terminals (measured in Tabby), so
      // this row — not the `j` row above — is what actually inserts the newline there. Leaving
      // the only terminal-independent way to type a second line to a dependency's default is
      // the same mistake ADR-104 already made once with `shift`.
      { name: 'linefeed', action: 'newline' },
    ],
  });
  // A bordered composer instead of a bare line: the input is where a person spends the
  // session, and an unstyled last row read as part of the transcript. Three rows total
  // (border, content, border); multiline input is still out of scope — `InputRenderable`
  // strips newlines and Enter is its submit event.
  const inputBox = new BoxRenderable(renderer, {
    id: 'cowcat-input-box',
    width: '100%',
    height: 3,
    border: true,
    borderStyle: 'rounded',
    borderColor: resolve(theme, 'border'),
    flexDirection: 'row',
  });
  const prompt = new TextRenderable(renderer, {
    id: 'cowcat-prompt',
    content: '› ',
    fg: resolve(theme, 'brand'),
    width: 2,
    height: 1,
  });
  inputBox.add(prompt);
  inputBox.add(input);
  main.add(body);
  main.add(dock);
  main.add(status);
  main.add(inputBox);
  page.add(main);
  root.add(page);

  // One renderable per line, updated in place when only the text or the colour changed.
  const mounted: TextRenderable[] = [];
  const specs: (Line | undefined)[] = [];
  // The aside's own mount state (ADR-163) — separate, so transcript scrolling never
  // touches it and vice versa.
  const asideBox = new BoxRenderable(renderer, {
    id: 'cowcat-aside',
    width: ASIDE_WIDTH,
    flexShrink: 0,
    flexDirection: 'column',
  });
  let asideMounted = false;
  const asidePanels: Panel[] = [];

  /**
   * The sidebar's visibility rule, shared by `contentWidth` (which must reserve its
   * columns before the frame is built) and `update` (which mounts it). 120 columns is
   * where a 100-column reading column plus 26 of rail still leaves the transcript
   * honest; below that the rail would be the layout, not an aside.
   */
  /** One titled panel inside a rail: a coloured header and a pooled stack of rows (ADR-168). */
  function makePanel(title: string, width: number): Panel {
    const box = new BoxRenderable(renderer, {
      id: `panel-${title}-${String(Math.round(Math.random() * 1e6))}`,
      width,
      flexDirection: 'column',
      marginBottom: 1,
    });
    const header = new BoxRenderable(renderer, {
      id: `panel-header-${title}-${String(Math.round(Math.random() * 1e6))}`,
      width: '100%',
      height: 1,
      backgroundColor: RGBA.fromHex('#A8C34A'),
    });
    header.add(new TextRenderable(renderer, {
      id: `panel-header-text-${title}-${String(Math.round(Math.random() * 1e6))}`,
      content: ` ${title}`,
      fg: RGBA.fromHex('#141419'),
      attributes: createTextAttributes({ bold: true }),
      wrapMode: 'none',
      width: '100%',
      height: 1,
    }));
    box.add(header);
    const rowsBox = new BoxRenderable(renderer, {
      id: `panel-rows-${title}-${String(Math.round(Math.random() * 1e6))}`,
      width: '100%',
      flexDirection: 'column',
    });
    box.add(rowsBox);
    const rowTexts: TextRenderable[] = [];
    return {
      box,
      setRows(rows: readonly { readonly text: string; readonly dim?: boolean; readonly accent?: boolean }[]) {
        for (const extra of rowTexts.splice(rows.length)) rowsBox.remove(extra);
        rows.forEach((row, index) => {
          let text = rowTexts[index];
          if (text === undefined) {
            text = new TextRenderable(renderer, {
              id: `panel-row-${title}-${String(index)}-${String(Math.round(Math.random() * 1e6))}`,
              content: '',
              wrapMode: 'none',
              width: '100%',
              height: 1,
            });
            rowTexts[index] = text;
            rowsBox.add(text);
          }
          text.content = ` ${row.text}`;
          text.fg = row.accent === true
            ? RGBA.fromHex('#4A9EDA')
            : row.dim === true
              ? RGBA.fromHex('#8A8A94')
              : RGBA.defaultForeground();
        });
      },
    };
  }

  /** Pool the panels of one rail to the spec's panel count and feed each its rows. */
  function renderRailPanels(
    rail: BoxRenderable,
    pool: Panel[],
    panels: readonly { readonly title: string; readonly rows: readonly { readonly text: string; readonly dim?: boolean; readonly accent?: boolean }[] }[],
    width: number,
  ): void {
    for (const extra of pool.splice(panels.length)) rail.remove(extra.box);
    panels.forEach((spec, index) => {
      let panel = pool[index];
      if (panel === undefined) {
        panel = makePanel(spec.title, width);
        pool[index] = panel;
        rail.add(panel.box);
      }
      panel.setRows(spec.rows);
    });
  }

  const ASIDE_MIN_WIDTH = 120;

  // The LEFT rail (ADR-167/168): todos / tasks / sub-agents / mascot, as COMPONENTS.
  // Same visibility rule as the right rail — a narrow terminal is the classic layout.
  const LEFT_RAIL_WIDTH = 24;
  const leftRailBox = new BoxRenderable(renderer, {
    id: 'cowcat-leftrail',
    width: LEFT_RAIL_WIDTH,
    flexShrink: 0,
    flexDirection: 'column',
  });
  let leftRailMounted = false;
  const leftRailPanels: Panel[] = [];
  const mascotText = new TextRenderable(renderer, {
    id: 'cowcat-mascot',
    content: '',
    fg: resolve(theme, 'textDim'),
    wrapMode: 'none',
    width: '100%',
    marginTop: 1,
  });
  leftRailBox.add(mascotText);

  function leftRailVisible(): boolean {
    return renderer.width >= ASIDE_MIN_WIDTH && process.env.COWCAT_SIDEBAR !== 'off';
  }

  function asideVisible(): boolean {
    return renderer.width >= ASIDE_MIN_WIDTH && process.env.COWCAT_SIDEBAR !== 'off';
  }
  const dockMounted: TextRenderable[] = [];
  const dockSpecs: (Line | undefined)[] = [];
  const images: ImageRenderable[] = [];

  let hitHandler: (id: string) => void = () => undefined;
  let scrollHandler: (delta: number) => void = () => undefined;

  /** Wire a row's click to its id. Re-run on update because a row can be recycled. */
  function attachHit(target: TextRenderable, spec: Line): void {
    const hit = spec.hit;
    if (hit === undefined) {
      target.onMouseDown = undefined;
      return;
    }
    target.onMouseDown = () => {
      hitHandler(hit);
    };
  }

  // The wheel goes to the body: a row only knows its own click, and the region that scrolls
  // is the transcript as a whole.
  body.onMouseScroll = (event) => {
    const scroll = event.scroll;
    if (scroll === undefined) return;
    const step = Math.max(1, Math.abs(scroll.delta));
    scrollHandler(scroll.direction === 'up' ? step : -step);
  };

  const BOLD = createTextAttributes({ bold: true });

  /**
   * A row's renderable content: the plain string, or — when the row carries markdown's
   * inline runs (ADR-162) — a StyledText with one chunk per span. The renderer's own rich
   * text path makes per-span colour and bold a property of the row's content, not of a
   * forest of child renderables, so the mount structure (one TextRenderable per row) is
   * unchanged.
   */
  function contentOf(spec: Line): string | StyledText {
    if (spec.runs === undefined || spec.runs.length === 0) return spec.text;
    const chunks: TextChunk[] = [];
    for (const run of spec.runs) {
      const fg = resolve(theme, run.token);
      chunks.push({
        __isChunk: true,
        text: run.text,
        ...(typeof fg === 'string' ? { fg: RGBA.fromHex(fg) } : {}),
        ...(run.bold === true ? { attributes: BOLD } : {}),
      });
    }
    return new StyledText(chunks);
  }

  /** Runs change the row's look without changing its text: compare them, or styled rows go stale. */
  function runsSignature(spec: Line): string {
    if (spec.runs === undefined) return '';
    return spec.runs.map((run) => `${run.token}:${run.bold === true ? 'b' : 'n'}:${String(run.text.length)}`).join('|');
  }

  function mountLines(
    container: BoxRenderable,
    target: TextRenderable[],
    specArray: (Line | undefined)[],
    lines: readonly Line[],
    scroll: number,
    room: number,
    idPrefix: string,
  ): number {
    // The tail, cut here rather than by a scroll box. Two measured reasons: a `ScrollBox` draws
    // a vertical scrollbar in the last column — a column the cards then do not have, so they
    // wrap and lose their right border — and its `stickyStart: 'bottom'` did not hold, so the
    // viewport showed the TOP of a long transcript and the newest card was off screen. Slicing
    // the last N lines is the behaviour a chat wants, and it keeps the mounted renderables to
    // what is actually visible.
    //
    // `scroll` is how many lines the reader has moved up from that tail: 0 follows new output,
    // which is the default and what a snapshot sees.
    const maxScroll = Math.max(0, lines.length - room);
    const offset = Math.max(0, Math.min(maxScroll, scroll));
    const start = Math.max(0, lines.length - room - offset);
    const visible = start === 0 ? lines : lines.slice(start);
    for (let index = 0; index < visible.length; index += 1) {
      const spec = visible[index];
      if (spec === undefined) continue;
      const previous = specArray[index];
      const existing = target[index];
      if (existing === undefined) {
        const created = new TextRenderable(renderer, {
          id: `${idPrefix}-${String(index)}`,
          content: contentOf(spec),
          fg: resolve(theme, spec.token),
          attributes: spec.bold ? createTextAttributes({ bold: true }) : TextAttributes.NONE,
          // Each `Line` is already wrapped by our own width table, so the renderer must not
          // wrap it again: a second wrap makes one logical row two visual rows, the column
          // overflows, flex shrinks the rows, and scrolling looks like the picture being
          // squeezed instead of moved (measured from the beta screenshot).
          wrapMode: 'none',
          width: '100%',
          height: 1,
          flexShrink: 0,
        });
        attachHit(created, spec);
        target[index] = created;
        specArray[index] = spec;
        container.add(created);
        continue;
      }
      if (
        previous !== undefined &&
        previous.text === spec.text &&
        previous.token === spec.token &&
        previous.bold === spec.bold &&
        previous.hit === spec.hit &&
        runsSignature(previous) === runsSignature(spec)
      ) {
        continue;
      }
      existing.content = contentOf(spec);
      existing.fg = resolve(theme, spec.token);
      existing.attributes = spec.bold ? BOLD : TextAttributes.NONE;
      attachHit(existing, spec);
      specArray[index] = spec;
    }
    // Shorter than before: unmount the tail. `remove` takes the id, and the array stays
    // aligned with the on-screen order.
    for (let index = visible.length; index < target.length; index += 1) {
      const extra = target[index];
      if (extra !== undefined) container.remove(extra);
    }
    target.length = visible.length;
    specArray.length = visible.length;
    // Where the visible window starts, so an image's row can be mapped onto it.
    return start;
  }

  /**
   * Mount the images over the rows the frame reserved for them.
   *
   * Absolutely positioned rather than added to the column: the rows ARE already there (a card
   * draws `│    │` for them, which is what keeps its border intact), so a flex child would push
   * the card's own frame apart. Measured — it did: the picture landed below the card, outside
   * its border, and everything moved down by its height.
   *
   * Remounted whenever the set changes rather than diffed in place: an image is expensive to
   * decode and cheap to mount, and the set changes only when a card appears or scrolls out.
   */
  function updateImages(slots: readonly ImageSlot[], viewStart: number): void {
    for (const existing of images) body.remove(existing);
    images.length = 0;
    for (const slot of slots) {
      const top = slot.row - viewStart;
      // Entirely scrolled out: nothing to mount, and nothing to decode.
      if (top + slot.rows <= 0 || top >= mounted.length) continue;
      const image = new ImageRenderable(renderer, {
        id: `cowcat-image-${String(slot.row)}`,
        // The bytes came over the protocol, so there is nothing to fetch and nothing to read
        // from disk on this side (ADR-057: the log holds references, the frontend asks).
        source: slot.source,
        protocol: 'auto',
        fit: 'fit',
        position: 'absolute',
        top,
        left: slot.left,
        width: slot.cols,
        height: slot.rows,
        onLoad: () => {
          // Decoding is asynchronous: without this the picture would appear only on the next
          // unrelated redraw, which on an idle session is never.
          renderer.requestRender();
        },
        onError: () => {
          // A malformed file, an unsupported format, a native core that cannot draw it: the
          // picture is simply absent, and the metadata line above it still says what it was.
          renderer.requestRender();
        },
      });
      body.add(image);
      images.push(image);
    }
  }

  return {
    contentWidth() {
      // Two cells for the root box's own border, then the reading-width cap (ADR-101): a
      // ADR-163: the 100-column reading column stays the default (the readability
      // measurement still holds); `COWCAT_WIDTH=full` is the explicit way out. A visible
      // aside has already been paid for out of the terminal's width, so the reading
      // column shrinks by exactly its width — cards must fit what they actually get.
      const rail = (asideVisible() ? ASIDE_WIDTH + 1 : 0) + (leftRailVisible() ? LEFT_RAIL_WIDTH + 1 : 0);
      // Three-column mode is full width (the rails own their columns); the solo mode
      // keeps the 100-column reading measurement (ADR-163).
      const base = rail > 0 || process.env.COWCAT_WIDTH === 'full' ? renderer.width - 2 : Math.min(renderer.width - 2, READING_WIDTH);
      return Math.max(8, base - rail);
    },
    contentHeight() {
      return renderer.height;
    },
    dialog(spec) {
      if (spec === undefined) {
        hideDialog();
        return;
      }
      updateDialog(spec);
    },
    wideRails() {
      return asideVisible();
    },
    update(spec) {
      // The dock takes its rows out of the transcript's budget; capping it at half the body
      // keeps a three-card dock from erasing the conversation on a 24-row terminal.
      const dockLines = spec.dock ?? [];
      // Root border (2) + status (1) + the composer's current height.
      const bodyBudget = Math.max(1, renderer.height - 3 - inputBox.height);
      const dockRoom = Math.min(dockLines.length, Math.max(1, Math.floor(bodyBudget / 2)));
      mountLines(dock, dockMounted, dockSpecs, dockLines.slice(0, dockRoom), 0, dockRoom, 'cowcat-dock');
      const viewStart = mountLines(
        body,
        mounted,
        specs,
        spec.body,
        spec.scroll ?? 0,
        Math.max(1, bodyBudget - dockRoom),
        'cowcat-line',
      );
      updateImages(spec.images ?? [], viewStart);
      // The dialog rides every update: its content is frame data like everything else.
      if (spec.dialog !== undefined) updateDialog(spec.dialog);
      else hideDialog();
      // The rails are COMPONENTS (ADR-168): each rail is a column of titled panels with
      // a coloured header; rows are pooled Text renderables updated in place. Mounting
      // is visible-toggle on statically-ordered children, so the position can never drift.
      const wantAside = spec.aside !== undefined && asideVisible();
      const wantLeft = spec.leftRail !== undefined && leftRailVisible();
      if (wantLeft !== leftRailMounted) {
        // Index 0: left of the main column, whichever rails mounted before it.
        if (wantLeft) page.add(leftRailBox, 0);
        else page.remove(leftRailBox);
        leftRailMounted = wantLeft;
      }
      const leftSpec = spec.leftRail;
      if (wantLeft && leftSpec !== undefined) {
        renderRailPanels(leftRailBox, leftRailPanels, leftSpec.panels, LEFT_RAIL_WIDTH - 1);
        mascotText.content = leftSpec.mascot.join('\n');
        mascotText.height = leftSpec.mascot.length;
        mascotText.visible = true;
      } else {
        mascotText.visible = false;
      }
      if (wantAside !== asideMounted) {
        if (wantAside) page.add(asideBox);
        else page.remove(asideBox);
        asideMounted = wantAside;
      }
      const asideData = spec.aside;
      if (wantAside && asideData !== undefined) {
        renderRailPanels(
          asideBox,
          asidePanels,
          asideData.panels.map((panel) => ({
            title: panel.title,
            rows: panel.rows.map((row) => ({
              text: `${row.label}  ${row.value}`,
              ...(row.valueAccent === true ? { accent: true } : {}),
            })),
          })),
          ASIDE_WIDTH - 1,
        );
      }
      // Three-column mode is FULL WIDTH — the rails already own their columns, and a
      // 100-column cap is what squeezed the middle column into a sliver (ADR-168).
      page.maxWidth = wantAside || wantLeft ? 100_000 : process.env.COWCAT_WIDTH === 'full' ? 100_000 : READING_WIDTH;
      status.content = spec.status.text;
      status.fg = resolve(theme, spec.status.token);
      input.placeholder = spec.placeholder;
      // The render loop is already running (`renderer.start()`); this is what tells it there
      // is something new to draw.
      renderer.requestRender();
    },
    onSubmit(handler) {
      // `TextareaRenderable` keeps a single submit listener rather than an emitter: the
      // action bound to `return` above calls `submit()`, which calls this.
      const listener = (): void => {
        handler(input.plainText);
      };
      input.onSubmit = listener;
      return () => {
        input.onSubmit = undefined;
      };
    },
    onKey(handler) {
      const listener = (key: KeyEvent): void => {
        handler(key);
      };
      renderer.keyInput.on('keypress', listener);
      return () => renderer.keyInput.off('keypress', listener);
    },
    onHit(handler) {
      hitHandler = handler;
      return () => {
        hitHandler = () => undefined;
      };
    },
    onScroll(handler) {
      scrollHandler = handler;
      return () => {
        scrollHandler = () => undefined;
      };
    },
    clearInput() {
      input.setText('');
      inputBox.height = 3;
    },
    setInput(text) {
      input.setText(text);
      inputBox.height = Math.min(6, Math.max(1, text.split('\n').length)) + 2;
      // A recalled draft or a completed command is there to be appended to, not typed in
      // front of: `setText` leaves the cursor at the start (ADR-106).
      input.gotoBufferEnd();
      input.focus();
    },
    inputValue() {
      return input.plainText;
    },
    cursorRow() {
      // Visual, not logical rows: the textarea's own ↑↓ move by *wrapped* row
      // (`moveUpVisual`), and the composer wraps at word boundaries by default. A long
      // single-line draft is therefore several rows tall, and its first row is not row 0 of
      // the buffer — using the logical row would recall history while the person is just
      // moving the caret up.
      return input.visualCursor.visualRow;
    },
    inputLineCount() {
      return Math.max(1, input.virtualLineCount);
    },
    syncInputSize() {
      const lines = Math.min(6, Math.max(1, input.plainText.split('\n').length));
      const next = lines + 2;
      if (inputBox.height !== next) inputBox.height = next;
    },
    focus() {
      input.focus();
    },
    destroy() {
      for (const image of images) body.remove(image);
      images.length = 0;
      renderer.root.remove(root);
    },  };
}

/** A token as a colour the renderer understands. */
function resolve(theme: Theme, token: TokenName): string | RGBA {
  const color = colorOf(theme, token);
  return color === null ? RGBA.defaultForeground() : color;
}
