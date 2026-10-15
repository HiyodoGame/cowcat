// Toast notifications, modeled on Open Code's ui/toast.tsx: one current toast
// + a queue, top-right overlay (top=1, right=2, maxWidth 60), variant-colored
// left/right border bars, bold title + wrapped message, 5s auto-dismiss, and a
// `+N more` row when the queue backs up. No mouse in a keyboard UI: esc (or a
// new toast while one is showing) dismisses/advances.
import { wrapText, visibleLen, truncateAnsi } from './render.js';
import { token } from './theme.js';

export const TOAST_VARIANTS = ['info', 'success', 'warning', 'error'];
export const TOAST_DURATION_MS = 5000;
export const TOAST_MAX_WIDTH = 60;
const PAD_L = 2;
const PAD_R = 3; // room for the `x` affordance

export class ToastQueue {
  constructor({ duration = TOAST_DURATION_MS, onChange = null } = {}) {
    this.duration = duration;
    this.onChange = onChange;
    this.current = null;
    this.queue = [];
    this._timer = null;
  }

  show({ variant = 'info', title = '', message = '', duration = null } = {}) {
    const item = { variant, title, message, duration: duration ?? this.duration };
    if (this.current) {
      // a toast is already up: queue behind it (this also dismisses the
      // current one into the queue order — OC behavior)
      this.queue.push(item);
    } else {
      this.current = item;
      this._arm(item.duration);
    }
    this.onChange?.();
    return item;
  }

  dismiss() {
    this._disarm();
    this.current = this.queue.shift() ?? null;
    if (this.current) this._arm(this.current.duration);
    this.onChange?.();
  }

  clear() {
    this._disarm();
    this.current = null;
    this.queue = [];
    this.onChange?.();
  }

  get pending() { return this.queue.length; }

  _arm(ms) {
    this._disarm();
    this._timer = setTimeout(() => this.dismiss(), ms);
    if (this._timer.unref) this._timer.unref();
  }

  _disarm() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}

// Render the toast box rows (each exactly boxW wide): variant-colored │ bars
// on both edges, bold title row with the `x` affordance, wrapped message
// rows, and a `+N more` tail when the queue is backed up.
export function renderToast(current, pending, { maxWidth = TOAST_MAX_WIDTH, colors = true, theme = null } = {}) {
  if (!current) return { boxW: 0, rows: [] };
  const variantColor = colors && theme ? token(theme, `feedback.${current.variant}`) : '';
  const base = colors && theme ? token(theme, 'text.base') : '';
  const dim = colors && theme ? token(theme, 'text.muted') : '';
  const reset = '\x1b[0m';
  const paint = (c, s) => (c ? `${c}${s}${reset}` : s);

  const innerW = Math.max(10, maxWidth - 2 - PAD_L - PAD_R);
  const title = current.title ? String(current.title) : '';
  const bodyLines = [];
  for (const l of wrapText(String(current.message ?? ''), innerW).slice(0, 4)) bodyLines.push(l);
  const more = pending > 0 ? `+${pending} more` : '';
  const contentW = Math.max(
    title ? visibleLen(title) + PAD_R + 1 : 0,
    ...bodyLines.map(visibleLen),
    more ? visibleLen(more) : 0,
  );
  const boxW = Math.min(maxWidth, contentW + 2 + PAD_L + PAD_R);

  const row = (inner) => {
    const body = ' '.repeat(PAD_L) + inner;
    const line = `${paint(variantColor, '│')}${body}${' '.repeat(Math.max(0, boxW - 2 - visibleLen(body)))}${paint(variantColor, '│')}`;
    return line;
  };
  const rows = [];
  if (title) {
    const affordance = paint(dim, 'x');
    const gap = ' '.repeat(Math.max(1, boxW - 2 - PAD_L - visibleLen(title) - visibleLen(affordance)));
    rows.push(row(`${paint(base, `\x1b[1m${title}`)}${gap}${affordance}`));
  }
  for (const l of bodyLines) rows.push(row(l));
  if (more) rows.push(row(paint(dim, more)));
  return { boxW, rows: rows.map((r) => truncateAnsi(r, boxW)) };
}
