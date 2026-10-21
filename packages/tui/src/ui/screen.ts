import {
  BoxRenderable,
  ImageRenderable,
  RGBA,
  TextareaRenderable,
  TextAttributes,
  TextRenderable,
  createTextAttributes,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { colorOf, type Theme, type TokenName } from '../theme/tokens.js';
import type { Line } from './line.js';

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
  focus(): void;
  destroy(): void;
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

  const page = new BoxRenderable(renderer, {
    id: 'cowcat-page',
    width: '100%',
    maxWidth: READING_WIDTH,
    alignSelf: 'center',
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
      { name: 'j', ctrl: true, action: 'newline' },
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
  page.add(body);
  page.add(dock);
  page.add(status);
  page.add(inputBox);
  root.add(page);

  // One renderable per line, updated in place when only the text or the colour changed.
  const mounted: TextRenderable[] = [];
  const specs: (Line | undefined)[] = [];
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
          content: spec.text,
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
        previous.hit === spec.hit
      ) {
        continue;
      }
      existing.content = spec.text;
      existing.fg = resolve(theme, spec.token);
      existing.attributes = spec.bold ? createTextAttributes({ bold: true }) : TextAttributes.NONE;
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
      // 200-column terminal gets a 100-column page, not a 198-column card.
      return Math.min(Math.max(8, renderer.width - 2), READING_WIDTH);
    },
    contentHeight() {
      return renderer.height;
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
