import type { TuiView } from './view.js';
import { slashMatches } from './commands.js';

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
  | { readonly kind: 'planMove'; readonly delta: number }
  /** Move the transcript viewport; positive is older content. */
  | { readonly kind: 'scroll'; readonly delta: number }
  /** Move the `/` menu highlight. */
  | { readonly kind: 'slashMove'; readonly delta: number }
  /** Complete the highlighted `/` command into the input. */
  | { readonly kind: 'slashAccept' }
  /** Close the `/` menu (Escape while it is open). */
  | { readonly kind: 'slashClose' }
  /** Jump back to the newest row and resume following. */
  | { readonly kind: 'scrollBottom' }
  /** Move the background-task panel's cursor (ADR-113). */
  | { readonly kind: 'taskMove'; readonly delta: number }
  /** Stop the task under the panel's cursor. */
  | { readonly kind: 'taskStop' }
  /** Close the background-task panel. */
  | { readonly kind: 'tasksClose' }
  /** Move the `/cron` panel's cursor (ADR-143 ③). */
  | { readonly kind: 'cronMove'; readonly delta: number }
  /** Delete the job under the panel's cursor via `cron.remove`. */
  | { readonly kind: 'cronDelete' }
  /** Close the `/cron` panel. */
  | { readonly kind: 'cronsClose' };

export function intentFor(key: KeyLike, view: TuiView): Intent | null {
  if (key.ctrl) {
    switch (key.name) {
      case 'c':
        return { kind: 'quit' };
      case 'p':
        // A pending question outranks chrome: Ctrl-P over an open review would hide the
        // card behind the palette while its arrows mean two things (review of #167, P2-9).
        return view.approval !== null || view.plan !== null ? null : { kind: 'palette' };
      case 'o':
        return { kind: 'toggleLastCard' };
      case 't':
        return { kind: 'toggleThinking' };
      case 'end':
        return { kind: 'scrollBottom' };
      default:
        return null;
    }
  }

  // The task panel is a list. It owns arrows, `x` and Escape — and nothing printable:
  // letters (including j/k) still belong to the input so a person can keep typing (ADR-113).
  if (view.taskPanel !== null) {
    if (key.name === 'up') return { kind: 'taskMove', delta: -1 };
    if (key.name === 'down') return { kind: 'taskMove', delta: 1 };
    if (key.name === 'x') return { kind: 'taskStop' };
    if (key.name === 'escape') return { kind: 'tasksClose' };
  }

  // The `/cron` panel owns the same keys while open (ADR-143 ③), same reasoning.
  if (view.cronPanel !== null) {
    if (key.name === 'up') return { kind: 'cronMove', delta: -1 };
    if (key.name === 'down') return { kind: 'cronMove', delta: 1 };
    if (key.name === 'x') return { kind: 'cronDelete' };
    if (key.name === 'escape') return { kind: 'cronsClose' };
  }

  // Arrow keys and j/k only mean something while there is a list to move through. Letting
  // them through otherwise would stop the input widget from ever seeing them.
  if (view.palette !== null) {
    if (key.name === 'up' || key.name === 'k') return { kind: 'paletteMove', delta: -1 };
    if (key.name === 'down' || key.name === 'j') return { kind: 'paletteMove', delta: 1 };
    if (key.name === 'escape') return { kind: 'palette' };
    return null;
  }

  // The `/` menu owns arrows, Tab and Escape while it is open; the input still owns the
  // letters. A space in the input closes the menu (slashMatches returns []). Neither it
  // nor the palette opens over a pending question — arrows belong to the card.
  if (view.approval === null && view.plan === null && slashMatches(view.input).length > 0) {
    if (key.name === 'up') return { kind: 'slashMove', delta: -1 };
    if (key.name === 'down') return { kind: 'slashMove', delta: 1 };
    if (key.name === 'tab') return { kind: 'slashAccept' };
    if (key.name === 'escape') return { kind: 'slashClose' };
  }

  if (key.name === 'escape') return { kind: 'cancel' };

  // Arrow keys belong to the open question while there is one: the input line is showing
  // four rows of answers, not a prompt to type into.
  if (view.approval !== null && view.approval.verdict === null) {
    if (key.name === 'up') return { kind: 'approvalMove', delta: -1 };
    if (key.name === 'down') return { kind: 'approvalMove', delta: 1 };
  }
  if (view.plan !== null) {
    if (key.name === 'up') return { kind: 'planMove', delta: -1 };
    if (key.name === 'down') return { kind: 'planMove', delta: 1 };
  }

  // Paging works while a question is open too: re-reading the transcript to decide is
  // exactly when a person needs it.
  if (key.name === 'pageup') return { kind: 'scroll', delta: 10 };
  if (key.name === 'pagedown') return { kind: 'scroll', delta: -10 };
  return null;
}
