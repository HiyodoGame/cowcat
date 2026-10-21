import type { TuiView } from './view.js';

/**
 * Keys → intents, as a pure function.
 *
 * The point of separating the two is that a keymap is the kind of code that rots silently:
 * a key stops working and nobody notices until a user complains. As a function of
 * `(key, view)` it is a table of assertions instead — including the ones that depend on the
 * view being in a particular state (Escape closes the palette when it is open and cancels
 * the turn when it is not).
 *
 * Enter is deliberately NOT here. It is the input widget's own event (`InputRenderable`
 * emits `enter` with the value), and mapping it in two places is how one keypress does two
 * things.
 */
export interface KeyLike {
  readonly name: string;
  readonly ctrl: boolean;
}

export type Intent =
  | { readonly kind: 'quit' }
  | { readonly kind: 'cancel' }
  /** Toggle the palette — the same intent opens and closes it. */
  | { readonly kind: 'palette' }
  | { readonly kind: 'paletteMove'; readonly delta: number }
  | { readonly kind: 'toggleLastCard' }
  | { readonly kind: 'toggleThinking' }
  /** Move the approval card's highlight; only meaningful while a question is open. */
  | { readonly kind: 'approvalMove'; readonly delta: number }
  /** Move the transcript viewport; positive is older content. */
  | { readonly kind: 'scroll'; readonly delta: number };

export function intentFor(key: KeyLike, view: TuiView): Intent | null {
  if (key.ctrl) {
    switch (key.name) {
      case 'c':
        return { kind: 'quit' };
      case 'p':
        return { kind: 'palette' };
      case 'o':
        return { kind: 'toggleLastCard' };
      case 't':
        return { kind: 'toggleThinking' };
      default:
        return null;
    }
  }

  // Arrow keys and j/k only mean something while there is a list to move through. Letting
  // them through otherwise would stop the input widget from ever seeing them.
  if (view.palette !== null) {
    if (key.name === 'up' || key.name === 'k') return { kind: 'paletteMove', delta: -1 };
    if (key.name === 'down' || key.name === 'j') return { kind: 'paletteMove', delta: 1 };
    if (key.name === 'escape') return { kind: 'palette' };
    return null;
  }

  if (key.name === 'escape') return { kind: 'cancel' };

  // Arrow keys belong to the open question while there is one: the input line is showing
  // four rows of answers, not a prompt to type into.
  if (view.approval !== null && view.approval.verdict === null) {
    if (key.name === 'up') return { kind: 'approvalMove', delta: -1 };
    if (key.name === 'down') return { kind: 'approvalMove', delta: 1 };
  }

  // Paging works while a question is open too: re-reading the transcript to decide is
  // exactly when a person needs it.
  if (key.name === 'pageup') return { kind: 'scroll', delta: 10 };
  if (key.name === 'pagedown') return { kind: 'scroll', delta: -10 };
  return null;
}
