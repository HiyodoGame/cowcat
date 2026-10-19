import {
  BoxRenderable,
  InputRenderable,
  RGBA,
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
 * the status line and the input line.
 */
const BODY_CHROME_ROWS = 4;

export interface ScreenSpec {
  readonly body: readonly Line[];
  readonly status: Line;
  readonly placeholder: string;
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
  /** Called with the input's value when the user presses Enter. */
  onSubmit(handler: (value: string) => void): () => void;
  /** Every keypress, including the ones the input swallowed. */
  onKey(handler: (key: KeyEvent) => void): () => void;
  clearInput(): void;
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

  const body = new BoxRenderable(renderer, {
    id: 'cowcat-body',
    flexGrow: 1,
    width: '100%',
    flexDirection: 'column',
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
  const input = new InputRenderable(renderer, {
    id: 'cowcat-input',
    width: '100%',
    placeholder: options.title,
  });
  root.add(body);
  root.add(status);
  root.add(input);

  // One renderable per line, updated in place when only the text or the colour changed.
  const mounted: TextRenderable[] = [];
  const specs: (Line | undefined)[] = [];

  function updateBody(lines: readonly Line[]): void {
    // The tail, cut here rather than by a scroll box. Two measured reasons: a `ScrollBox` draws
    // a vertical scrollbar in the last column — a column the cards then do not have, so they
    // wrap and lose their right border — and its `stickyStart: 'bottom'` did not hold, so the
    // viewport showed the TOP of a long transcript and the newest card was off screen. Slicing
    // the last N lines is the behaviour a chat wants, and it keeps the mounted renderables to
    // what is actually visible.
    const room = Math.max(1, renderer.height - BODY_CHROME_ROWS);
    const visible = lines.length > room ? lines.slice(-room) : lines;
    for (let index = 0; index < visible.length; index += 1) {
      const spec = visible[index];
      if (spec === undefined) continue;
      const previous = specs[index];
      const existing = mounted[index];
      if (existing === undefined) {
        const created = new TextRenderable(renderer, {
          id: `cowcat-line-${String(index)}`,
          content: spec.text,
          fg: resolve(theme, spec.token),
          attributes: spec.bold ? createTextAttributes({ bold: true }) : TextAttributes.NONE,
          wrapMode: 'word',
        });
        mounted[index] = created;
        specs[index] = spec;
        body.add(created);
        continue;
      }
      if (previous !== undefined && previous.text === spec.text && previous.token === spec.token && previous.bold === spec.bold) {
        continue;
      }
      existing.content = spec.text;
      existing.fg = resolve(theme, spec.token);
      existing.attributes = spec.bold ? createTextAttributes({ bold: true }) : TextAttributes.NONE;
      specs[index] = spec;
    }
    // Shorter than before: unmount the tail. `remove` takes the id, and the array stays
    // aligned with the on-screen order.
    for (let index = visible.length; index < mounted.length; index += 1) {
      const extra = mounted[index];
      if (extra !== undefined) body.remove(extra);
    }
    mounted.length = visible.length;
    specs.length = visible.length;
  }

  return {
    contentWidth() {
      // Two cells for the root box's own border. Everything inside is laid out by width alone,
      // so this is the one place that has to know about it.
      return Math.max(8, renderer.width - 2);
    },
    update(spec) {
      updateBody(spec.body);
      status.content = spec.status.text;
      status.fg = resolve(theme, spec.status.token);
      input.placeholder = spec.placeholder;
      // The render loop is already running (`renderer.start()`); this is what tells it there
      // is something new to draw.
      renderer.requestRender();
    },
    onSubmit(handler) {
      const listener = (value: string): void => {
        handler(value);
      };
      // NOT `onSubmit`: `InputRenderable` overrides `submit()` and only emits `'enter'`
      // (`node_modules/@opentui/core/index.node.js:8673-8684`), so the option is dead code.
      input.on('enter', listener);
      return () => input.off('enter', listener);
    },
    onKey(handler) {
      const listener = (key: KeyEvent): void => {
        handler(key);
      };
      renderer.keyInput.on('keypress', listener);
      return () => renderer.keyInput.off('keypress', listener);
    },
    clearInput() {
      input.value = '';
    },
    focus() {
      input.focus();
    },
    destroy() {
      renderer.root.remove(root);
    },
  };
}

/** A token as a colour the renderer understands. */
function resolve(theme: Theme, token: TokenName): string | RGBA {
  const color = colorOf(theme, token);
  return color === null ? RGBA.defaultForeground() : color;
}
