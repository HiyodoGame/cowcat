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
  /** Shift+Tab arrives as name 'tab' with this set (ADR-160 ①). */
  readonly shift?: boolean;
}

export type Intent =
  | { readonly kind: 'quit' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'clearInput' }
  | { readonly kind: 'armExit' }
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
  | { readonly kind: 'cronsClose' }
  /** Shift+Tab's three-state cycle: normal → accept-edits → plan → normal (ADR-160 ①). */
  | { readonly kind: 'modeCycle' }
  /** Idle Esc number one: arm the double-press window (ADR-160 ②). */
  | { readonly kind: 'armRecall' }
  /** Idle Esc number two inside the window: bring the last prompt back (ADR-160 ②). */
  | { readonly kind: 'recallLast' }
  /** Ctrl+L: back to the tail and repaint now (ADR-160 ③). */
  | { readonly kind: 'repaint' }
  /** Move the pre-session trust card's two-row highlight (ADR-157 ①). */
  | { readonly kind: 'trustMove'; readonly delta: number }
  /** Escape on the trust card is the same answer as the 跳过 row (ADR-157 ①). */
  | { readonly kind: 'trustSkip' }
  /** Move the `/sessions` picker's cursor (ADR-158 ②). */
  | { readonly kind: 'sessionMove'; readonly delta: number }
  /** Close the `/sessions` picker. */
  | { readonly kind: 'sessionsClose' }
  | { readonly kind: 'historySearch' }
  | { readonly kind: 'historyMove'; readonly delta: number };

export function intentFor(key: KeyLike, view: TuiView, now = 0, exitArmUntil = 0, escArmUntil = 0): Intent | null {
  if (key.ctrl) {
    switch (key.name) {
      case 'c': {
        const running = view.turn !== null && !['completed', 'failed', 'cancelled'].includes(view.turn.state);
        if (running) return { kind: 'cancel' };
        if (view.input !== '') return { kind: 'clearInput' };
        return now < exitArmUntil ? { kind: 'quit' } : { kind: 'armExit' };
      }
      case 'd':
        return view.input === '' ? { kind: 'quit' } : null;
      case 'p':
        // A pending question outranks chrome: Ctrl-P over an open review would hide the
        // card behind the palette while its arrows mean two things (review of #167, P2-9).
        // The pre-session trust card outranks it for the same reason (ADR-157 ①).
        return (view.approval !== null && view.approval.verdict === null) || view.plan !== null || view.trust !== null
          ? null
          : { kind: 'palette' };
      case 'o':
        return { kind: 'toggleLastCard' };
      case 't':
        return { kind: 'toggleThinking' };
      case 'r':
        return { kind: 'historySearch' };
      case 'end':
        return { kind: 'scrollBottom' };
      case 'l':
        return { kind: 'repaint' };
      default:
        return null;
    }
  }

  if (view.historySearch !== null) {
    if (key.name === 'up') return { kind: 'historyMove', delta: -1 };
    if (key.name === 'down') return { kind: 'historyMove', delta: 1 };
    if (key.name === 'escape') return { kind: 'historySearch' };
    return null;
  }

  // The pre-session trust card owns the arrows while it is the question on screen
  // (ADR-157 ①); Enter and the y/n shortcuts arrive through submit, like an approval.
  if (view.trust !== null) {
    if (key.name === 'up') return { kind: 'trustMove', delta: -1 };
    if (key.name === 'down') return { kind: 'trustMove', delta: 1 };
    if (key.name === 'escape') return { kind: 'trustSkip' };
  }

  // Shift+Tab cycles the mode everywhere (ADR-160 ①): it is a whole-app state, not a
  // widget's, and nothing else binds the key — Tab itself only completes the `/` menu.
  if (key.name === 'tab' && key.shift === true) return { kind: 'modeCycle' };

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

  // The `/sessions` picker owns arrows and Escape (ADR-158 ②); Enter picks through
  // submit, the same way the palette and the `/` menu run their highlighted row.
  if (view.sessionPanel !== null) {
    if (key.name === 'up') return { kind: 'sessionMove', delta: -1 };
    if (key.name === 'down') return { kind: 'sessionMove', delta: 1 };
    if (key.name === 'escape') return { kind: 'sessionsClose' };
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
  // nor the palette opens over a pending question — arrows belong to the card. An
  // ANSWERED approval that lingers until its turn ends is not a pending question: the
  // frame shows the menu again and these keys reach it (the frame and this condition
  // must agree, or the menu is visible but its keys are dead).
  const questionOpen = (view.approval !== null && view.approval.verdict === null) || view.plan !== null;
  if (!questionOpen && slashMatches(view.input).length > 0) {
    if (key.name === 'up') return { kind: 'slashMove', delta: -1 };
    if (key.name === 'down') return { kind: 'slashMove', delta: 1 };
    if (key.name === 'tab') return { kind: 'slashAccept' };
    if (key.name === 'escape') return { kind: 'slashClose' };
  }

  if (key.name === 'escape') {
    const running = view.turn !== null && !['completed', 'failed', 'cancelled'].includes(view.turn.state);
    if (running) return { kind: 'cancel' };
    // Idle Esc (ADR-160 ②): the second press inside the window brings the last prompt
    // back into the input; the first only arms, silently, so a stray Esc costs nothing.
    return now < escArmUntil ? { kind: 'recallLast' } : { kind: 'armRecall' };
  }

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

  if (view.input === '' && key.name === 'up') return { kind: 'scroll', delta: 1 };
  if (view.input === '' && key.name === 'down') return { kind: 'scroll', delta: -1 };

  // Paging works while a question is open too: re-reading the transcript to decide is
  // exactly when a person needs it.
  if (key.name === 'pageup') return { kind: 'scroll', delta: 10 };
  if (key.name === 'pagedown') return { kind: 'scroll', delta: -10 };
  return null;
}
