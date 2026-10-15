// Dialog stack primitive, modeled on Open Code's ui/dialog.tsx: a stack of
// frame overlays with esc-close-top and focus restore, rendered as an in-frame
// floating layer (the dimmed band + solid dialog surface are painted by the
// UI's draw pass via rows()).
export const DIALOG_WIDTHS = { medium: 60, large: 88, xlarge: 116 };

export function dialogWidth(size) {
  return DIALOG_WIDTHS[size] ?? DIALOG_WIDTHS.medium;
}

// Pick the widest size that still fits the terminal (box keeps a 1-col margin
// each side); falls back to medium and lets the frame clamp.
export function pickDialogSize(termWidth) {
  if (termWidth >= DIALOG_WIDTHS.xlarge + 2) return 'xlarge';
  if (termWidth >= DIALOG_WIDTHS.large + 2) return 'large';
  return 'medium';
}

export class DialogStack {
  constructor({ onFocusChange = null } = {}) {
    this._stack = [];
    this._focus = null;         // restore token captured when the first dialog opens
    this._onFocusChange = onFocusChange;
  }

  get depth() { return this._stack.length; }
  get top() { return this._stack[this._stack.length - 1] ?? null; }
  isOpen() { return this._stack.length > 0; }

  // dialog: { id?, title, render(boxWidth) -> string[] (content lines),
  //           renderActions?(boxWidth) -> string[] (bottom action bar),
  //           onKey?(chord) -> bool (handled), onClose?() }
  open(dialog) {
    if (this._stack.length === 0) {
      this._focus = this._captureFocus?.() ?? null;
      this._onFocusChange?.(false);
    }
    this._stack.push(dialog);
    return dialog;
  }

  // Replace the whole stack with a single dialog (all previous onClose fire).
  replace(dialog) {
    for (const d of this._stack) d.onClose?.();
    this._stack = [];
    return this.open(dialog);
  }

  // Esc: close the top dialog, restore focus when the stack empties.
  closeTop() {
    const d = this._stack.pop();
    if (d) d.onClose?.();
    if (this._stack.length === 0) this._restoreFocus();
    return d ?? null;
  }

  clear() {
    for (const d of this._stack) d.onClose?.();
    this._stack = [];
    this._restoreFocus();
  }

  _restoreFocus() {
    const focus = this._focus;
    this._focus = null;
    this._onFocusChange?.(true);
    if (typeof focus === 'function') focus();
  }
}
